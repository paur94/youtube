import "server-only";

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { MAX_MEDIA_BYTES, MEDIA_TYPES } from "@/lib/production";

// Originals are kept on local disk: provider URLs expire (Higgsfield deletes outputs after 7 days).
export function getMediaRoot() {
  // Runtime data, not part of the build: keep Turbopack from tracing it into the output.
  return path.resolve(/*turbopackIgnore: true*/ process.env.MEDIA_DIR || path.join(process.cwd(), "storage", "media"));
}

/** Absolute path for a stored relative path, or null if it would escape the media root. */
export function resolveMediaPath(relative: string, root = getMediaRoot()) {
  if (!relative || relative.includes("\0") || path.isAbsolute(relative)) return null;
  const full = path.resolve(root, relative);
  const rel = path.relative(root, full);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return full;
}

export function normalizeContentType(contentType: string | null | undefined) {
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  return type === "image/jpg" ? "image/jpeg" : type;
}

export class MediaError extends Error {}

/** Validates type and size, writes the file and returns its path relative to the media root. */
export async function saveMedia(bytes: Uint8Array, contentType: string, folder: string) {
  const type = MEDIA_TYPES[normalizeContentType(contentType)];
  if (!type) throw new MediaError(`Unsupported file type ${contentType || "(unknown)"}. Use PNG, JPEG, WebP, GIF, MP4, WebM or MOV.`);
  if (bytes.byteLength === 0) throw new MediaError("The file is empty");
  if (bytes.byteLength > MAX_MEDIA_BYTES[type.kind]) {
    throw new MediaError(`The file is larger than ${MAX_MEDIA_BYTES[type.kind] / 1024 / 1024} MB`);
  }
  const relative = `${folder}/${randomUUID()}.${type.ext}`;
  const full = resolveMediaPath(relative);
  if (!full) throw new MediaError("Invalid storage path");
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, bytes);
  return { filePath: relative, kind: type.kind, contentType: normalizeContentType(contentType), sizeBytes: bytes.byteLength };
}

/** Stores a provider input that isn't an asset (e.g. Hedra driving audio); the caller validates it. */
export async function saveInputFile(bytes: Uint8Array, ext: string, folder: string) {
  const relative = `${folder}/${randomUUID()}.${ext}`;
  const full = resolveMediaPath(relative);
  if (!full) throw new MediaError("Invalid storage path");
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, bytes);
  return relative;
}

/** Downloads a remote file (https only) into the media folder. */
export async function downloadMedia(url: string, folder: string, fetchImpl: typeof fetch = fetch) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MediaError("Enter a valid URL");
  }
  if (parsed.protocol !== "https:") throw new MediaError("Only https:// URLs can be imported");

  const response = await fetchImpl(parsed, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new MediaError(`Download failed with HTTP ${response.status}`);
  const contentType = normalizeContentType(response.headers.get("content-type")) || guessType(parsed.pathname);
  const type = MEDIA_TYPES[contentType];
  if (!type) throw new MediaError(`The URL doesn't point to a supported image or video (${contentType || "unknown type"})`);
  const length = Number(response.headers.get("content-length"));
  if (length > MAX_MEDIA_BYTES[type.kind]) throw new MediaError("The file is too large to import");

  const bytes = new Uint8Array(await response.arrayBuffer());
  return saveMedia(bytes, contentType, folder);
}

function guessType(pathname: string) {
  const ext = pathname.split(".").pop()?.toLowerCase();
  const match = Object.entries(MEDIA_TYPES).find(([, t]) => t.ext === ext || (ext === "jpeg" && t.ext === "jpg"));
  return match?.[0] ?? "";
}

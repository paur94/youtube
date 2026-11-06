import { type FileHandle, open, stat } from "node:fs/promises";
import path from "node:path";

import { MEDIA_TYPES } from "@/lib/production";
import { MUSIC_TYPES } from "@/lib/shorts";
import { resolveMediaPath } from "@/server/media/storage";

// Serves stored assets from MEDIA_DIR. Supports Range requests so video previews can seek.
export async function GET(request: Request, ctx: RouteContext<"/media/[...path]">) {
  const { path: segments } = await ctx.params;
  const file = resolveMediaPath(segments.join("/"));
  if (!file) return new Response("Not found", { status: 404 });

  let size: number;
  try {
    const info = await stat(file);
    if (!info.isFile()) return new Response("Not found", { status: 404 });
    size = info.size;
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const ext = path.extname(file).slice(1).toLowerCase();
  const contentType =
    Object.entries(MEDIA_TYPES).find(([, t]) => t.ext === ext)?.[0] ?? Object.entries(MUSIC_TYPES).find(([, e]) => e === ext)?.[0] ?? "application/octet-stream";
  const headers = {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
  };

  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    const stream = fileStream(file, start, end);
    return new Response(stream, {
      status: 206,
      headers: { ...headers, "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${size}` },
    });
  }

  const stream = fileStream(file, 0, size - 1);
  return new Response(stream, { headers: { ...headers, "Content-Length": String(size) } });
}

const CHUNK_SIZE = 64 * 1024;

// Pull-based so reads stop as soon as the client aborts (e.g. a <video> seek cancels its range request).
// Readable.toWeb keeps pushing after cancel and throws "Controller is already closed".
function fileStream(file: string, start: number, end: number): ReadableStream<Uint8Array> {
  let handle: FileHandle | undefined;
  let position = start;
  const closeHandle = async () => {
    const h = handle;
    handle = undefined;
    await h?.close().catch(() => {});
  };

  return new ReadableStream<Uint8Array>({
    async start() {
      handle = await open(file, "r");
    },
    async pull(controller) {
      if (!handle) return;
      const length = Math.min(CHUNK_SIZE, end - position + 1);
      if (length <= 0) {
        await closeHandle();
        controller.close();
        return;
      }
      try {
        const { bytesRead, buffer } = await handle.read(new Uint8Array(length), 0, length, position);
        if (bytesRead === 0) {
          await closeHandle();
          controller.close();
          return;
        }
        position += bytesRead;
        controller.enqueue(buffer.subarray(0, bytesRead));
      } catch (err) {
        await closeHandle();
        controller.error(err);
      }
    },
    cancel: closeHandle,
  });
}

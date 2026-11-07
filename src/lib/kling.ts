import type { HiggsfieldModel } from "./higgsfield";

// Kling 4.0 keyframes, as served by Replicate (https://replicate.com/kwaivgi/kling-v4.0, input schema
// checked November 2026):
//   start_image      first frame
//   middle_images[]  keyframes between the first and last frame, in order
//   end_image        last frame
//   reference_images[] characters, objects, scenes or style
// Every image: .jpg/.jpeg/.png, max 30 MB, min 300 px, aspect ratio between 2:5 and 5:2. Up to 10 images in
// total across all image inputs, numbered in the prompt as @image_1, @image_2, ... in the order start,
// middle, end, references. aspect_ratio is ignored whenever an image is given (it comes from the images).

export const KLING_IMAGE_TYPES = ["image/jpeg", "image/png"] as const;
export const MAX_KLING_IMAGE_BYTES = 30 * 1024 * 1024;
export const KLING_MIN_IMAGE_SIDE = 300;
/** Width divided by height must stay between 2:5 and 5:2. */
export const KLING_MIN_ASPECT = 2 / 5;
export const KLING_MAX_ASPECT = 5 / 2;
/** All image inputs together (start + middle + end + references). */
export const KLING_MAX_IMAGES = 10;
/**
 * Kling's own keyframe mode takes one first, one last and up to 8 middle frames. Replicate only states the
 * 10-image total, so this is the stricter of the two; a start frame is always sent, which leaves 9 at most.
 */
export const KLING_MAX_MIDDLE_IMAGES = 8;

export const KLING_IMAGE_RULES = "JPEG or PNG, up to 30 MB, at least 300 px on each side, aspect ratio between 2:5 and 5:2";

/** Stored in production_scenes.continuity.frames: the scene's middle and end keyframes for Kling 4.0. */
export type SceneFrames = {
  /** Keyframes between the first and last frame, in the order the clip passes through them. */
  middleAssetIds: string[];
  /** Image the clip ends on, or null to let the model decide. */
  endAssetId: string | null;
};

export const EMPTY_SCENE_FRAMES: SceneFrames = { middleAssetIds: [], endAssetId: null };

export function readSceneFrames(value: { frames?: Partial<SceneFrames> | null } | null | undefined): SceneFrames {
  const frames = value?.frames;
  return {
    middleAssetIds: Array.isArray(frames?.middleAssetIds) ? frames.middleAssetIds.filter((id) => typeof id === "string") : [],
    endAssetId: typeof frames?.endAssetId === "string" ? frames.endAssetId : null,
  };
}

/** True for catalog models that accept Kling keyframes (middle and end images). */
export function supportsKeyframes(model: Pick<HiggsfieldModel, "frames"> | null | undefined) {
  return Boolean(model?.frames);
}

export type ImageSize = { width: number; height: number };

/**
 * Reads the pixel size from a PNG or JPEG header, without decoding the image. Returns null for any other
 * format or a truncated file, in which case the size checks are skipped.
 */
export function readImageSize(bytes: Uint8Array): ImageSize | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // PNG: 8-byte signature, then the IHDR chunk with width and height as big-endian uint32.
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    return width && height ? { width, height } : null;
  }
  // JPEG: walk the segments until a start-of-frame marker (SOFn), which carries height then width.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1];
      if (marker === 0xff) {
        offset++;
        continue;
      }
      // Standalone markers have no length field.
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const length = view.getUint16(offset + 2);
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) {
        const height = view.getUint16(offset + 5);
        const width = view.getUint16(offset + 7);
        return width && height ? { width, height } : null;
      }
      if (marker === 0xd9 || marker === 0xda) return null;
      offset += 2 + length;
    }
  }
  return null;
}

export type KlingImageInput = {
  contentType: string | null;
  sizeBytes: number | null;
  /** Pixel size when known; omit to skip the dimension checks. */
  size?: ImageSize | null;
};

/** Why Kling would reject this image, or null when it meets every documented requirement. */
export function checkKlingImage(image: KlingImageInput, role: string): string | null {
  if (!image.contentType || !(KLING_IMAGE_TYPES as readonly string[]).includes(image.contentType)) {
    return `The ${role} must be a JPEG or PNG image (Kling doesn't accept ${describeType(image.contentType)})`;
  }
  if (image.sizeBytes != null && image.sizeBytes > MAX_KLING_IMAGE_BYTES) return `The ${role} is larger than 30 MB`;
  if (image.size) {
    const { width, height } = image.size;
    if (width < KLING_MIN_IMAGE_SIDE || height < KLING_MIN_IMAGE_SIDE) {
      return `The ${role} is ${width}×${height} px; Kling needs at least ${KLING_MIN_IMAGE_SIDE} px on each side`;
    }
    const aspect = width / height;
    if (aspect < KLING_MIN_ASPECT || aspect > KLING_MAX_ASPECT) {
      return `The ${role} is ${width}×${height} px; Kling needs an aspect ratio between 2:5 and 5:2`;
    }
  }
  return null;
}

function describeType(contentType: string | null) {
  if (!contentType) return "files of unknown type";
  const subtype = contentType.split("/")[1];
  return subtype ? subtype.toUpperCase() : contentType;
}

export type KlingImageCounts = { start: boolean; middle: number; end: boolean; references?: number };

/** Why Kling would reject this mix of images, or null when it fits the documented limits. */
export function checkKlingImageCounts(counts: KlingImageCounts): string | null {
  if (counts.middle > KLING_MAX_MIDDLE_IMAGES) return `Kling takes at most ${KLING_MAX_MIDDLE_IMAGES} middle images`;
  const total = Number(counts.start) + counts.middle + Number(counts.end) + (counts.references ?? 0);
  if (total > KLING_MAX_IMAGES) return `Kling takes at most ${KLING_MAX_IMAGES} images in total; this request has ${total}`;
  return null;
}

/**
 * Tells Kling what each keyframe is, using its @image_N numbering (start first, then middle images in order,
 * then the end image). Empty when only a start image is sent, since that case needs no explanation.
 */
export function describeKlingFrames(counts: Pick<KlingImageCounts, "middle" | "end">) {
  if (!counts.middle && !counts.end) return "";
  const parts = ["@image_1 is the first frame."];
  if (counts.middle) {
    const first = 2;
    const last = first + counts.middle - 1;
    const names = Array.from({ length: counts.middle }, (_, i) => `@image_${first + i}`);
    parts.push(
      counts.middle === 1
        ? `${names[0]} is a keyframe the clip passes through midway.`
        : `${names.slice(0, -1).join(", ")} and ${names.at(-1)} are keyframes the clip passes through in that order, spread evenly over its length.`,
    );
    if (counts.end) parts.push(`@image_${last + 1} is the last frame.`);
  } else if (counts.end) {
    parts.push("@image_2 is the last frame.");
  }
  parts.push("Move smoothly from one keyframe to the next, keeping the characters, their outfits, the setting and the art style identical in every frame.");
  return parts.join(" ");
}

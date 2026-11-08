import type { AspectRatio, AssetKind } from "./production";
import type { REPLICATE_PROVIDER } from "./replicate";

// Only endpoints and parameters published in Higgsfield's API docs and OpenAPI spec
// (https://docs.higgsfield.ai/docs/openapi.json and https://docs.higgsfield.ai/docs/models.md,
// checked October 2026). Add a model here only after confirming its path and body in the docs.
export type HiggsfieldModel = {
  id: string;
  label: string;
  /** Path under https://api.higgsfield.ai used to submit a request. */
  path: string;
  output: AssetKind;
  /** "image" models animate a start frame passed as image_url. */
  input: "text" | "image";
  /** Any whole number of seconds in this range. */
  durationRange?: readonly [min: number, max: number];
  aspectRatios?: readonly string[];
  supportsNegativePrompt: boolean;
  maxImages?: number;
  /** Body field for the start image, when it is not image_url (Higgsfield) or image (Replicate). */
  imageField?: string;
  /** Accepts this many ordered reference images (image_urls), used to keep characters consistent. */
  maxReferenceImages?: number;
  /** Body field for the reference images, when it is not image_urls. */
  referenceField?: string;
  /** The prompt refers to the attached images as @image_1, @image_2, ... (Kling 4.0). */
  imageTags?: boolean;
  /**
   * Accepts keyframes besides the start image (Kling 4.0): ordered middle images and an end image, sent in
   * these body fields. The image rules and the 10-image total live in ./kling.
   */
  frames?: { middleField: string; endField: string };
  /** Fixed, documented fields sent with every request. */
  fixedBody?: Record<string, unknown>;
  /** Always generates its own soundtrack; the API has no switch for it. */
  nativeAudio?: boolean;
  /** Served by Replicate instead of Higgsfield; path is then under https://api.replicate.com/v1. */
  provider?: typeof REPLICATE_PROVIDER;
  /** Replicate price per second of output at the fixed resolution, for the cost estimate. */
  usdPerSecond?: number;
};

const SOUL_ASPECT_RATIOS = ["1:1", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5", "16:9", "9:16", "21:9"];
const GROK_ASPECT_RATIOS = ["1:1", "1:2", "2:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"];

// Wan 3.0 defaults to 1080p; 720p keeps test runs cheap. Native sound, so the prompt carries the dialogue.
const WAN_ASPECT_RATIOS = ["16:9", "4:3", "1:1", "3:4", "9:16"];
const WAN_BODY = { resolution: "720p", generate_audio: true };

// Wan 3.0 on Replicate (https://replicate.com/alibaba/wan-3): one model for text and image to video,
// $0.10/s at 720p. It always generates sound (checked on an example output: AAC track, no switch in the
// schema), so the prompt carries the dialogue. No reference images, and aspect_ratio is ignored with a
// start image. Prompt expansion is off so the scene prompt is used as written.
const REPLICATE_WAN_PATH = "/models/alibaba/wan-3/predictions";
const REPLICATE_WAN_BODY = { resolution: "720p", enable_prompt_expansion: false };

// Kling 4.0 on Replicate (https://replicate.com/kwaivgi/kling-v4.0, schema checked November 2026): one model
// for text, keyframes (start_image, middle_images, end_image) and reference images, $0.157/s at 720p, 3-30s.
// It always generates sound (checked on example outputs: AAC track, no switch in the schema). No negative
// prompt, and aspect_ratio is ignored whenever an image is given. Up to 10 images across all image inputs.
const REPLICATE_KLING_PATH = "/models/kwaivgi/kling-v4.0/predictions";
const KLING_ASPECT_RATIOS = ["16:9", "9:16", "1:1", "21:9"];
const REPLICATE_KLING_BODY = { resolution: "720p" };

export const HIGGSFIELD_MODELS: readonly HiggsfieldModel[] = [
  {
    id: "soul-standard",
    label: "Soul (image)",
    path: "/higgsfield-ai/soul/standard",
    output: "image",
    input: "text",
    aspectRatios: SOUL_ASPECT_RATIOS,
    supportsNegativePrompt: false,
    maxImages: 4,
  },
  {
    id: "soul-v2-standard",
    label: "Soul V2 (image, prompt only)",
    path: "/higgsfield-ai/soul/v2/standard",
    output: "image",
    input: "text",
    supportsNegativePrompt: false,
  },
  {
    id: "grok-image-2",
    label: "Grok Image 2.0 (image, character references)",
    path: "/xai/grok-imagine-image-2.0",
    output: "image",
    input: "text",
    aspectRatios: GROK_ASPECT_RATIOS,
    supportsNegativePrompt: false,
    maxReferenceImages: 10,
    // 2k keyframes hold up as start frames for 1080p clips.
    fixedBody: { quality: "medium", resolution: "2k" },
  },
  {
    id: "wan-3.0-i2v",
    label: "Wan 3.0 (image to video, 720p, sound, ~$1 per 10s)",
    path: "/alibaba/wan-3.0/image-to-video",
    output: "video",
    input: "image",
    durationRange: [2, 30],
    aspectRatios: WAN_ASPECT_RATIOS,
    supportsNegativePrompt: false,
    fixedBody: WAN_BODY,
  },
  {
    id: "wan-3.0-r2v",
    label: "Wan 3.0 (character references to video, 720p, sound, ~$1 per 10s + refs)",
    path: "/alibaba/wan-3.0/reference-to-video",
    output: "video",
    input: "text",
    durationRange: [2, 30],
    aspectRatios: WAN_ASPECT_RATIOS,
    supportsNegativePrompt: false,
    maxReferenceImages: 10,
    fixedBody: WAN_BODY,
  },
  {
    id: "wan-3.0-t2v",
    label: "Wan 3.0 (text to video, 720p, sound, ~$1 per 10s)",
    path: "/alibaba/wan-3.0/text-to-video",
    output: "video",
    input: "text",
    durationRange: [2, 30],
    aspectRatios: WAN_ASPECT_RATIOS,
    supportsNegativePrompt: false,
    fixedBody: WAN_BODY,
  },
  {
    id: "replicate-wan-3-i2v",
    label: "Wan 3.0 via Replicate (image to video, 720p, sound, ~$1 per 10s)",
    path: REPLICATE_WAN_PATH,
    output: "video",
    input: "image",
    durationRange: [2, 30],
    supportsNegativePrompt: true,
    fixedBody: REPLICATE_WAN_BODY,
    provider: "replicate",
    usdPerSecond: 0.1,
    nativeAudio: true,
  },
  {
    id: "replicate-wan-3-t2v",
    label: "Wan 3.0 via Replicate (text to video, 720p, sound, ~$1 per 10s)",
    path: REPLICATE_WAN_PATH,
    output: "video",
    input: "text",
    durationRange: [2, 30],
    aspectRatios: WAN_ASPECT_RATIOS,
    supportsNegativePrompt: true,
    fixedBody: REPLICATE_WAN_BODY,
    provider: "replicate",
    usdPerSecond: 0.1,
    nativeAudio: true,
  },
  {
    id: "replicate-kling-4-i2v",
    label: "Kling 4.0 via Replicate (start, middle & end frames to video, 720p, sound, ~$1.57 per 10s)",
    path: REPLICATE_KLING_PATH,
    output: "video",
    input: "image",
    imageField: "start_image",
    frames: { middleField: "middle_images", endField: "end_image" },
    durationRange: [3, 30],
    supportsNegativePrompt: false,
    fixedBody: REPLICATE_KLING_BODY,
    provider: "replicate",
    usdPerSecond: 0.157,
    imageTags: true,
    nativeAudio: true,
  },
  {
    id: "replicate-kling-4-r2v",
    label: "Kling 4.0 via Replicate (character references to video, 720p, sound, ~$1.57 per 10s)",
    path: REPLICATE_KLING_PATH,
    output: "video",
    input: "text",
    durationRange: [3, 30],
    aspectRatios: KLING_ASPECT_RATIOS,
    supportsNegativePrompt: false,
    maxReferenceImages: 10,
    referenceField: "reference_images",
    fixedBody: REPLICATE_KLING_BODY,
    provider: "replicate",
    usdPerSecond: 0.157,
    imageTags: true,
    nativeAudio: true,
  },
  {
    id: "replicate-kling-4-t2v",
    label: "Kling 4.0 via Replicate (text to video, 720p, sound, ~$1.57 per 10s)",
    path: REPLICATE_KLING_PATH,
    output: "video",
    input: "text",
    durationRange: [3, 30],
    aspectRatios: KLING_ASPECT_RATIOS,
    supportsNegativePrompt: false,
    fixedBody: REPLICATE_KLING_BODY,
    provider: "replicate",
    usdPerSecond: 0.157,
    imageTags: true,
    nativeAudio: true,
  },
];

export const DEFAULT_IMAGE_MODEL = "grok-image-2";
export const DEFAULT_VIDEO_MODEL = "wan-3.0-i2v";

export const HIGGSFIELD_WEB_URL = "https://higgsfield.ai";

export function getHiggsfieldModel(id: string) {
  return HIGGSFIELD_MODELS.find((m) => m.id === id) ?? null;
}

/** True for video models that produce their own soundtrack, so the prompt should carry the dialogue. */
export function generatesAudio(model: HiggsfieldModel) {
  return model.output === "video" && (model.nativeAudio === true || model.fixedBody?.generate_audio === true);
}

/** Clip length a model will be asked for, given the scene length; null for image models. */
export function modelDuration(model: HiggsfieldModel, seconds: number) {
  if (!model.durationRange) return null;
  const [min, max] = model.durationRange;
  return Math.min(max, Math.max(min, Math.ceil(seconds)));
}

/** Human-readable clip lengths a model supports. */
export function describeDurations(model: HiggsfieldModel) {
  return model.durationRange ? `${model.durationRange[0]}–${model.durationRange[1]}s` : null;
}

export function pickAspectRatio(supported: readonly string[], wanted: AspectRatio) {
  return supported.includes(wanted) ? wanted : supported.includes("16:9") ? "16:9" : supported[0];
}

export type GenerationParams = {
  prompt: string;
  negativePrompt?: string;
  aspectRatio: AspectRatio;
  durationSeconds: number;
  imageUrl?: string;
  numImages?: number;
  /** Public URLs of character reference images, in the order the prompt names them. */
  referenceUrls?: string[];
  /** Keyframes between the start and end image, in order; only models with `frames` send them. */
  middleImageUrls?: string[];
  /** Last frame of the clip; only models with `frames` send it. */
  endImageUrl?: string;
};

/** The JSON body for a model, using only the fields its documentation lists. */
export function buildRequestBody(model: HiggsfieldModel, params: GenerationParams): Record<string, unknown> {
  const body: Record<string, unknown> = { prompt: params.prompt, ...model.fixedBody };
  if (model.input === "image") {
    if (!params.imageUrl) throw new Error(`${model.label} needs a start image`);
    body[model.imageField ?? (model.provider === "replicate" ? "image" : "image_url")] = params.imageUrl;
  }
  if (model.frames) {
    if (params.middleImageUrls?.length) body[model.frames.middleField] = params.middleImageUrls;
    if (params.endImageUrl) body[model.frames.endField] = params.endImageUrl;
  }
  if (model.aspectRatios) body.aspect_ratio = pickAspectRatio(model.aspectRatios, params.aspectRatio);
  if (model.maxReferenceImages && params.referenceUrls?.length) {
    body[model.referenceField ?? "image_urls"] = params.referenceUrls.slice(0, model.maxReferenceImages);
  }
  if (model.maxImages) body.num_images = Math.min(model.maxImages, Math.max(1, params.numImages ?? 1));
  const duration = modelDuration(model, params.durationSeconds);
  if (duration !== null) body.duration = duration;
  if (model.supportsNegativePrompt && params.negativePrompt?.trim()) {
    body.negative_prompt = params.negativePrompt.trim();
  }
  return body;
}

/** Duration of the clip a request will produce, for the asset record. */
export function outputDuration(model: HiggsfieldModel, body: Record<string, unknown>) {
  return model.output === "video" && typeof body.duration === "number" ? body.duration : null;
}

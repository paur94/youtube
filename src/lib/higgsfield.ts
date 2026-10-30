import type { AspectRatio, AssetKind } from "./production";

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
  /** Fixed clip lengths the model accepts. */
  durations?: readonly number[];
  /** Any whole number of seconds in this range. */
  durationRange?: readonly [min: number, max: number];
  aspectRatios?: readonly string[];
  supportsNegativePrompt: boolean;
  maxImages?: number;
  /** Accepts this many ordered reference images (image_urls), used to keep characters consistent. */
  maxReferenceImages?: number;
  /** Fixed, documented fields sent with every request. */
  fixedBody?: Record<string, unknown>;
};

const SOUL_ASPECT_RATIOS = ["1:1", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5", "16:9", "9:16", "21:9"];
const GROK_ASPECT_RATIOS = ["1:1", "1:2", "2:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"];
const SEEDANCE_ASPECT_RATIOS = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"];
// Narration and music are produced separately, so generated audio is switched off.
const SEEDANCE_BODY = { resolution: "1080p", generate_audio: false };

// 720p with native sound: about $0.51 per 10s, far cheaper than Seedance 2.5 at 1080p (~$11 per 10s).
const PIXVERSE_BODY = { resolution: "720p", generate_audio: true };

// Wan 3.0 defaults to 1080p; 720p keeps test runs cheap. Native sound, so the prompt carries the dialogue.
const WAN_ASPECT_RATIOS = ["16:9", "4:3", "1:1", "3:4", "9:16"];
const WAN_BODY = { resolution: "720p", generate_audio: true };

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
    id: "pixverse-v6-i2v",
    label: "PixVerse V6 (image to video, 720p, sound)",
    path: "/pixverse/v6/image-to-video",
    output: "video",
    input: "image",
    durationRange: [1, 15],
    supportsNegativePrompt: true,
    fixedBody: PIXVERSE_BODY,
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
    id: "seedance-2.5-i2v",
    label: "Seedance 2.5 (image to video, 1080p, expensive: ~$11 per 10s)",
    path: "/bytedance/seedance-2.5/image-to-video",
    output: "video",
    input: "image",
    durationRange: [4, 30],
    supportsNegativePrompt: false,
    fixedBody: SEEDANCE_BODY,
  },
  {
    id: "seedance-2.5-t2v",
    label: "Seedance 2.5 (text to video)",
    path: "/bytedance/seedance-2.5/text-to-video",
    output: "video",
    input: "text",
    durationRange: [4, 30],
    aspectRatios: SEEDANCE_ASPECT_RATIOS,
    supportsNegativePrompt: false,
    fixedBody: SEEDANCE_BODY,
  },
  {
    id: "kling-2.5-turbo-pro-i2v",
    label: "Kling 2.5 Turbo Pro (image to video)",
    path: "/kling-video/v2.5-turbo/pro/image-to-video",
    output: "video",
    input: "image",
    durations: [5, 10],
    supportsNegativePrompt: true,
  },
  {
    id: "kling-2.5-turbo-standard-i2v",
    label: "Kling 2.5 Turbo Standard (image to video)",
    path: "/kling-video/v2.5-turbo/standard/image-to-video",
    output: "video",
    input: "image",
    durations: [5, 10],
    supportsNegativePrompt: true,
  },
  {
    id: "kling-2.5-turbo-pro-t2v",
    label: "Kling 2.5 Turbo Pro (text to video)",
    path: "/kling-video/v2.5-turbo/pro/text-to-video",
    output: "video",
    input: "text",
    durations: [5, 10],
    supportsNegativePrompt: true,
  },
  {
    id: "hailuo-2.3-standard-i2v",
    label: "Hailuo 2.3 Standard (image to video)",
    path: "/minimax/hailuo-2.3/standard/image-to-video",
    output: "video",
    input: "image",
    durations: [6, 10],
    supportsNegativePrompt: false,
  },
  {
    id: "hailuo-2.3-standard-t2v",
    label: "Hailuo 2.3 Standard (text to video)",
    path: "/minimax/hailuo-2.3/standard/text-to-video",
    output: "video",
    input: "text",
    durations: [6, 10],
    supportsNegativePrompt: false,
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
  return model.output === "video" && model.fixedBody?.generate_audio === true;
}

/** Smallest supported duration that covers the scene, or the longest one available. */
export function pickDuration(durations: readonly number[], seconds: number) {
  const sorted = [...durations].sort((a, b) => a - b);
  return sorted.find((d) => d >= seconds) ?? sorted[sorted.length - 1];
}

/** Clip length a model will be asked for, given the scene length; null for image models. */
export function modelDuration(model: HiggsfieldModel, seconds: number) {
  if (model.durationRange) {
    const [min, max] = model.durationRange;
    return Math.min(max, Math.max(min, Math.ceil(seconds)));
  }
  return model.durations ? pickDuration(model.durations, seconds) : null;
}

/** Human-readable clip lengths a model supports. */
export function describeDurations(model: HiggsfieldModel) {
  if (model.durationRange) return `${model.durationRange[0]}–${model.durationRange[1]}s`;
  return model.durations ? `${model.durations.join(" or ")}s` : null;
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
};

/** The JSON body for a model, using only the fields its documentation lists. */
export function buildRequestBody(model: HiggsfieldModel, params: GenerationParams): Record<string, unknown> {
  const body: Record<string, unknown> = { prompt: params.prompt, ...model.fixedBody };
  if (model.input === "image") {
    if (!params.imageUrl) throw new Error(`${model.label} needs a start image`);
    body.image_url = params.imageUrl;
  }
  if (model.aspectRatios) body.aspect_ratio = pickAspectRatio(model.aspectRatios, params.aspectRatio);
  if (model.maxReferenceImages && params.referenceUrls?.length) {
    body.image_urls = params.referenceUrls.slice(0, model.maxReferenceImages);
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

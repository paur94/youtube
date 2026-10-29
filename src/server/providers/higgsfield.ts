import "server-only";

import { z } from "zod";

// Higgsfield REST API (https://docs.higgsfield.ai). Everything here follows the published docs:
// - Auth: `Authorization: Key {HF_API_KEY_ID}:{HF_API_KEY_SECRET}`
// - Submit: POST {model path} -> { status: "queued", request_id, status_url, cancel_url }
// - Status: GET /requests/{id}/status; cancel: POST /requests/{id}/cancel (queued only)
// - Uploads: POST /files/generate-upload-url, then PUT the file to the presigned URL
// - Estimate: POST /estimate/{model path} -> { usd }
// - Retries: same Idempotency-Key after timeouts, network errors, 5xx and 429.
// Webhooks (`hf_webhook`) are not used: they need a public HTTPS endpoint and this app runs locally.

export const HIGGSFIELD_API_URL = "https://api.higgsfield.ai";

export const NOT_CONFIGURED_MESSAGE =
  "Higgsfield API is not configured. Add HF_API_KEY_ID and HF_API_KEY_SECRET to .env.local and restart the server, or use the manual workflow.";

export function getHiggsfieldConfig() {
  const keyId = process.env.HF_API_KEY_ID?.trim() ?? "";
  const keySecret = process.env.HF_API_KEY_SECRET?.trim() ?? "";
  return { keyId, keySecret, configured: Boolean(keyId && keySecret) };
}

const mediaOutputSchema = z.object({ url: z.url() });

export const requestStatusSchema = z.object({
  status: z.enum(["queued", "in_progress", "completed", "failed", "nsfw", "canceled"]),
  request_id: z.string(),
  status_url: z.string().optional(),
  cancel_url: z.string().optional(),
  error: z.string().nullish(),
  images: z.array(mediaOutputSchema).nullish(),
  video: mediaOutputSchema.nullish(),
  expires_at: z.string().nullish(),
});

export type RequestStatus = z.infer<typeof requestStatusSchema>;

export class HiggsfieldError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "HiggsfieldError";
  }
}

/** Maps an HTTP status (null for network errors) to a user-facing message, per the errors guide. */
export function describeHiggsfieldError(status: number | null, detail?: string) {
  const suffix = detail ? ` (${detail})` : "";
  switch (status) {
    case null:
      return "Could not reach the Higgsfield API. Check your connection and retry.";
    case 400:
      return `Higgsfield rejected the request${suffix}. Adjust the prompt or settings.`;
    case 401:
      return "Higgsfield rejected the API key. Check HF_API_KEY_ID and HF_API_KEY_SECRET.";
    case 403:
      return "Your Higgsfield API balance is too low. Add funds in the Higgsfield console, then retry.";
    case 404:
      return `Higgsfield could not find this request or model for your account${suffix}.`;
    case 409:
      return "The request is still running.";
    case 422:
      return `Higgsfield could not validate the request${suffix}.`;
    case 423:
      return "This Higgsfield model is temporarily blocked. Try again later or choose another model.";
    case 429:
      return "Higgsfield's queue for your account is full or rate limited. Retry in a moment.";
    case 503:
      return "The Higgsfield model is unavailable right now. Retry later.";
    default:
      return status >= 500
        ? `Higgsfield had a server error (HTTP ${status}). Retry later.`
        : `Higgsfield returned HTTP ${status}${suffix}.`;
  }
}

function isRetryable(status: number | null) {
  return status === null || status === 429 || status >= 500;
}

async function readDetail(response: Response) {
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === "string") return body.detail.slice(0, 300);
    if (Array.isArray(body.detail)) {
      return body.detail
        .map((d) => (d && typeof d === "object" && "msg" in d ? String(d.msg) : String(d)))
        .join("; ")
        .slice(0, 300);
    }
  } catch {
    // Non-JSON error body.
  }
  return undefined;
}

export type HiggsfieldClientOptions = {
  keyId: string;
  keySecret: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  timeoutMs?: number;
};

export function createHiggsfieldClient(options: HiggsfieldClientOptions) {
  const baseUrl = options.baseUrl ?? HIGGSFIELD_API_URL;
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxAttempts = options.maxAttempts ?? 3;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const auth = `Key ${options.keyId}:${options.keySecret}`;

  async function request(
    method: "GET" | "POST",
    path: string,
    init: { body?: unknown; idempotencyKey?: string; retry?: boolean } = {},
  ) {
    const retry = init.retry ?? true;
    for (let attempt = 1; ; attempt++) {
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}${path}`, {
          method,
          headers: {
            Authorization: auth,
            Accept: "application/json",
            ...(init.body !== undefined && { "Content-Type": "application/json" }),
            ...(init.idempotencyKey && { "Idempotency-Key": init.idempotencyKey }),
          },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal: AbortSignal.timeout(timeoutMs),
          cache: "no-store",
        });
      } catch {
        if (retry && attempt < maxAttempts) {
          await sleep(backoff(attempt));
          continue;
        }
        throw new HiggsfieldError(describeHiggsfieldError(null), null, true);
      }

      if (response.ok) return response;

      const status = response.status;
      if (retry && isRetryable(status) && attempt < maxAttempts) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : backoff(attempt));
        continue;
      }
      const detail = await readDetail(response);
      throw new HiggsfieldError(describeHiggsfieldError(status, detail), status, isRetryable(status));
    }
  }

  async function parseStatus(response: Response) {
    const parsed = requestStatusSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new HiggsfieldError("Higgsfield returned a response this app doesn't recognise.", response.status, false);
    }
    return parsed.data;
  }

  return {
    /** Submits a generation. The idempotency key makes resubmitting after a timeout safe. */
    async submit(modelPath: string, body: Record<string, unknown>, idempotencyKey: string) {
      return parseStatus(await request("POST", modelPath, { body, idempotencyKey }));
    },

    async getStatus(requestId: string) {
      return parseStatus(await request("GET", `/requests/${encodeURIComponent(requestId)}/status`));
    },

    /** Only succeeds while the request is still queued. */
    async cancel(requestId: string) {
      await request("POST", `/requests/${encodeURIComponent(requestId)}/cancel`, { retry: false });
    },

    /** USD estimate for a request, or null when the API offers no estimate for it. */
    async estimate(modelPath: string, body: Record<string, unknown>) {
      try {
        const response = await request("POST", `/estimate${modelPath}`, { body, retry: false });
        const data = (await response.json()) as { usd?: unknown };
        const usd = Number(data.usd);
        return Number.isFinite(usd) && usd >= 0 ? usd : null;
      } catch {
        return null;
      }
    },

    /** Uploads a local file so models can read it via image_url. Returns its public URL. */
    async uploadFile(bytes: Uint8Array, contentType: string) {
      const response = await request("POST", "/files/generate-upload-url", { body: { content_type: contentType } });
      const target = z
        .object({ public_url: z.url(), upload_url: z.url(), upload_headers: z.record(z.string(), z.string()).optional() })
        .safeParse(await response.json().catch(() => null));
      if (!target.success) throw new HiggsfieldError("Higgsfield returned an unexpected upload response.", null, false);

      // The presigned storage URL must not receive the API credentials.
      let put: Response;
      try {
        put = await fetchImpl(target.data.upload_url, {
          method: "PUT",
          headers: { "Content-Type": contentType, ...target.data.upload_headers },
          body: bytes as BodyInit,
          signal: AbortSignal.timeout(120_000),
        });
      } catch {
        throw new HiggsfieldError("Uploading the start image to Higgsfield failed. Retry.", null, true);
      }
      if (!put.ok) throw new HiggsfieldError(`Uploading the start image failed (HTTP ${put.status}).`, put.status, true);
      return target.data.public_url;
    },
  };
}

export type HiggsfieldClient = ReturnType<typeof createHiggsfieldClient>;

export function getHiggsfieldClient(): HiggsfieldClient | null {
  const config = getHiggsfieldConfig();
  if (!config.configured) return null;
  return createHiggsfieldClient({ keyId: config.keyId, keySecret: config.keySecret });
}

function backoff(attempt: number) {
  return Math.min(8000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
}

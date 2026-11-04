import "server-only";

import { z } from "zod";

import type { ReplicatePrediction } from "@/lib/replicate";

// Replicate HTTP API (https://replicate.com/docs/reference/http). Everything here follows the published docs:
// - Auth: `Authorization: Bearer {REPLICATE_API_TOKEN}`
// - Submit: POST /models/{owner}/{name}/predictions { input } -> 201 { id, status, ... }
// - Status: GET /predictions/{id}; cancel: POST /predictions/{id}/cancel
// - Uploads: POST /files (multipart field "content") -> { urls: { get } }, usable as a file input
// - Errors: problem+json { title, detail, status }
// There are no idempotency keys, so a submit is only retried when Replicate rejected it (429).
// Webhooks are not used: they need a public HTTPS endpoint and this app runs locally.

export const REPLICATE_API_URL = "https://api.replicate.com/v1";

export const REPLICATE_NOT_CONFIGURED_MESSAGE =
  "Replicate API is not configured. Add REPLICATE_API_TOKEN to .env.local and restart the server.";

export function getReplicateConfig() {
  const apiToken = process.env.REPLICATE_API_TOKEN?.trim() ?? "";
  return { apiToken, configured: Boolean(apiToken) };
}

const predictionSchema = z.object({
  id: z.string(),
  status: z.enum(["starting", "processing", "succeeded", "failed", "canceled", "aborted"]),
  output: z.union([z.string(), z.array(z.string())]).nullish(),
  error: z.unknown().nullish(),
  completed_at: z.string().nullish(),
});

export class ReplicateError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ReplicateError";
  }
}

/** Maps an HTTP status (null for network errors) to a user-facing message. */
export function describeReplicateError(status: number | null, detail?: string) {
  const suffix = detail ? ` (${detail})` : "";
  switch (status) {
    case null:
      return "Could not reach the Replicate API. Check your connection and retry.";
    case 400:
      return `Replicate rejected the request${suffix}. Adjust the prompt or settings.`;
    case 401:
      return "Replicate rejected the API token. Check REPLICATE_API_TOKEN.";
    case 402:
      return "Your Replicate account has no credit left. Add billing in the Replicate dashboard, then retry.";
    case 403:
      return `Your Replicate token doesn't allow this${suffix}.`;
    case 404:
      return `Replicate could not find this prediction or model${suffix}.`;
    case 422:
      return `Replicate could not validate the request${suffix}.`;
    case 429:
      return "Replicate is rate limiting this account. Retry in a moment.";
    default:
      return status >= 500
        ? `Replicate had a server error (HTTP ${status}). Retry later.`
        : `Replicate returned HTTP ${status}${suffix}.`;
  }
}

function isRetryable(status: number | null) {
  return status === null || status === 429 || status >= 500;
}

async function readDetail(response: Response) {
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === "string") return body.detail.slice(0, 300);
  } catch {
    // Non-JSON error body.
  }
  return undefined;
}

export type ReplicateClientOptions = {
  apiToken: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  timeoutMs?: number;
};

export function createReplicateClient(options: ReplicateClientOptions) {
  const baseUrl = options.baseUrl ?? REPLICATE_API_URL;
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxAttempts = options.maxAttempts ?? 3;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const auth = `Bearer ${options.apiToken}`;

  async function request(
    method: "GET" | "POST",
    path: string,
    init: { body?: { json: unknown } | { form: () => FormData }; retry?: "all" | "rejected" | "none" } = {},
  ) {
    const { body } = init;
    const retry = init.retry ?? "all";
    for (let attempt = 1; ; attempt++) {
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}${path}`, {
          method,
          headers: {
            Authorization: auth,
            Accept: "application/json",
            ...(body && "json" in body && { "Content-Type": "application/json" }),
          },
          // A fresh FormData per attempt: a body stream can only be read once.
          body: !body ? undefined : "json" in body ? JSON.stringify(body.json) : body.form(),
          signal: AbortSignal.timeout(body && "form" in body ? 120_000 : timeoutMs),
          cache: "no-store",
        });
      } catch {
        if (retry === "all" && attempt < maxAttempts) {
          await sleep(backoff(attempt));
          continue;
        }
        throw new ReplicateError(describeReplicateError(null), null, true);
      }

      if (response.ok) return response;

      const status = response.status;
      const canRetry = retry === "all" ? isRetryable(status) : retry === "rejected" && status === 429;
      if (canRetry && attempt < maxAttempts) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : backoff(attempt));
        continue;
      }
      const detail = await readDetail(response);
      throw new ReplicateError(describeReplicateError(status, detail), status, isRetryable(status));
    }
  }

  async function parsePrediction(response: Response): Promise<ReplicatePrediction> {
    const parsed = predictionSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new ReplicateError("Replicate returned a response this app doesn't recognise.", response.status, false);
    const { error, ...rest } = parsed.data;
    return { ...rest, error: error == null ? null : typeof error === "string" ? error : JSON.stringify(error).slice(0, 300) };
  }

  return {
    /** Creates a prediction on an official model; path is /models/{owner}/{name}/predictions. */
    async createPrediction(path: string, input: Record<string, unknown>) {
      return parsePrediction(await request("POST", path, { body: { json: { input } }, retry: "rejected" }));
    },

    async getPrediction(id: string) {
      return parsePrediction(await request("GET", `/predictions/${encodeURIComponent(id)}`));
    },

    async cancel(id: string) {
      await request("POST", `/predictions/${encodeURIComponent(id)}/cancel`, { retry: "none" });
    },

    /** Uploads a local file so a model can read it as a file input. Returns the URL to pass. */
    async uploadFile(bytes: Uint8Array, contentType: string) {
      const extension = contentType.split("/")[1]?.replace("jpeg", "jpg") ?? "bin";
      const response = await request("POST", "/files", {
        body: {
          form: () => {
            const form = new FormData();
            form.set("content", new Blob([bytes as BlobPart], { type: contentType }), `input.${extension}`);
            return form;
          },
        },
      });
      const parsed = z.object({ urls: z.object({ get: z.url() }) }).safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw new ReplicateError("Replicate returned an unexpected upload response.", null, false);
      return parsed.data.urls.get;
    },
  };
}

export type ReplicateClient = ReturnType<typeof createReplicateClient>;

export function getReplicateClient(): ReplicateClient | null {
  const config = getReplicateConfig();
  if (!config.configured) return null;
  return createReplicateClient({ apiToken: config.apiToken });
}

function backoff(attempt: number) {
  return Math.min(8000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
}

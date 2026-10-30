import "server-only";

import { z } from "zod";

import type { HedraJob } from "@/lib/hedra";

// Hedra API v3 (https://www.hedra.com/docs). Everything here follows the published docs:
// - Auth: `Authorization: Key {HEDRA_API_KEY}` (the key is "<key_id>:<secret>")
// - Uploads: POST /files (multipart field "file") -> { url, content_type, expires_at }; handles last an hour
// - Submit: POST /models/{model} { input, idempotency_key } -> 202 { job_id, status, ... }
// - Result: GET /jobs/{job_id} -> { status, error, outputs: [{ status, url }] }
// - Errors: { error: { code, message, retryable, retry_after }, trace_id }
// Webhooks are not used: they need a public HTTPS endpoint and this app runs locally.

export const HEDRA_API_URL = "https://api.hedra.com/v3";

export const HEDRA_NOT_CONFIGURED_MESSAGE =
  "Hedra API is not configured. Add HEDRA_API_KEY to .env.local and restart the server.";

export function getHedraConfig() {
  const apiKey = process.env.HEDRA_API_KEY?.trim() ?? "";
  return { apiKey, configured: Boolean(apiKey) };
}

const submitSchema = z.object({ job_id: z.string(), status: z.string() });

const jobSchema = z.object({
  status: z.enum(["IN_QUEUE", "IN_PROGRESS", "COMPLETED", "FAILED"]),
  error: z.union([z.string(), z.object({ code: z.string().optional(), message: z.string().optional() })]).nullish(),
  outputs: z.array(z.object({ status: z.string().nullish(), url: z.string().nullish() })).nullish(),
});

export class HedraError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "HedraError";
  }
}

/** Maps an HTTP status (null for network errors) to a user-facing message. */
export function describeHedraError(status: number | null, detail?: string) {
  const suffix = detail ? ` (${detail})` : "";
  switch (status) {
    case null:
      return "Could not reach the Hedra API. Check your connection and retry.";
    case 400:
      return `Hedra rejected the request${suffix}. Check the image, audio and settings.`;
    case 401:
      return "Hedra rejected the API key. Check HEDRA_API_KEY.";
    case 402:
      return "Your Hedra API wallet can't cover this job. Add funds in Hedra (studio credits don't apply), then retry.";
    case 403:
      return `Your Hedra key or plan doesn't allow this${suffix}.`;
    case 404:
      return `Hedra could not find this job or model${suffix}.`;
    case 422:
      return `Hedra's moderation refused the content${suffix}. Change the image, audio or prompt.`;
    case 429:
      return "Hedra is rate limiting this account. Retry in a moment.";
    default:
      return status >= 500 ? `Hedra had a server error (HTTP ${status}). Retry later.` : `Hedra returned HTTP ${status}${suffix}.`;
  }
}

function isRetryable(status: number | null) {
  return status === null || status === 429 || status >= 500;
}

async function readDetail(response: Response) {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    if (typeof body.error?.message === "string") return body.error.message.slice(0, 300);
  } catch {
    // Non-JSON error body.
  }
  return undefined;
}

export type HedraClientOptions = {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  timeoutMs?: number;
};

export function createHedraClient(options: HedraClientOptions) {
  const baseUrl = options.baseUrl ?? HEDRA_API_URL;
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxAttempts = options.maxAttempts ?? 3;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const auth = `Key ${options.apiKey}`;

  async function request(method: "GET" | "POST", path: string, body?: { json: unknown } | { form: () => FormData }) {
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
        if (attempt < maxAttempts) {
          await sleep(backoff(attempt));
          continue;
        }
        throw new HedraError(describeHedraError(null), null, true);
      }

      if (response.ok) return response;

      const status = response.status;
      if (isRetryable(status) && attempt < maxAttempts) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : backoff(attempt));
        continue;
      }
      const detail = await readDetail(response);
      throw new HedraError(describeHedraError(status, detail), status, isRetryable(status));
    }
  }

  async function parse<T>(response: Response, schema: z.ZodType<T>) {
    const parsed = schema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new HedraError("Hedra returned a response this app doesn't recognise.", response.status, false);
    return parsed.data;
  }

  return {
    /** Uploads a file for use as a model input. Returns the handle to pass as { source: "url", url }. */
    async uploadFile(bytes: Uint8Array, contentType: string, name: string) {
      const response = await request("POST", "/files", {
        form: () => {
          const form = new FormData();
          form.set("file", new Blob([bytes as BlobPart], { type: contentType }), name);
          return form;
        },
      });
      return (await parse(response, z.object({ url: z.string().min(1) }))).url;
    },

    /** Submits a model job. The idempotency key makes resubmitting after a timeout safe. */
    async submit(model: string, input: Record<string, unknown>, idempotencyKey: string) {
      const response = await request("POST", `/models/${encodeURIComponent(model)}`, {
        json: { input, idempotency_key: idempotencyKey },
      });
      return parse(response, submitSchema);
    },

    async getJob(jobId: string): Promise<HedraJob> {
      return parse(await request("GET", `/jobs/${encodeURIComponent(jobId)}`), jobSchema);
    },
  };
}

export type HedraClient = ReturnType<typeof createHedraClient>;

export function getHedraClient(): HedraClient | null {
  const config = getHedraConfig();
  if (!config.configured) return null;
  return createHedraClient({ apiKey: config.apiKey });
}

function backoff(attempt: number) {
  return Math.min(8000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
}

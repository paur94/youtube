import "server-only";

import { z } from "zod";

import type { TokenUsage } from "@/lib/ai-usage";
import { storyContentSchema } from "@/lib/stories";

import type { GenerationResult, StructuredResult } from "./claude";

// OpenAI Responses API (https://platform.openai.com/docs/api-reference/responses), used for story
// generation, Short analysis and video metadata suggestions. Called with fetch: one endpoint, streamed so long stories don't hit HTTP timeouts.
// The API key is read from the server environment only ("server-only" keeps it out of client bundles).

export const OPENAI_API_URL = "https://api.openai.com/v1";
export const DEFAULT_OPENAI_MODEL = "gpt-6.1-sol";
export const OPENAI_EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
export type OpenAIEffort = (typeof OPENAI_EFFORT_LEVELS)[number];

const STORY_MAX_OUTPUT_TOKENS = 64_000;

export const OPENAI_NOT_CONFIGURED_MESSAGE =
  "OpenAI is not configured. Add OPENAI_API_KEY to .env.local and restart the dev server.";

export function getOpenAIConfig() {
  const effort = process.env.OPENAI_EFFORT?.trim() as OpenAIEffort | undefined;
  return {
    configured: Boolean(process.env.OPENAI_API_KEY?.trim()),
    model: process.env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL,
    effort: effort && OPENAI_EFFORT_LEVELS.includes(effort) ? effort : ("medium" as OpenAIEffort),
  };
}

type JsonSchema = { [key: string]: unknown };

/**
 * Strict structured outputs need every object closed (additionalProperties: false) with all of its
 * properties required. The output side of the Zod schema already requires defaulted fields; this
 * enforces the rest and drops keywords strict mode rejects.
 */
export function toStrictJsonSchema(schema: z.ZodType): JsonSchema {
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== "object") return node;
    const out: JsonSchema = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "$schema" || key === "default") continue;
      out[key] = visit(value);
    }
    if (out.type === "object" && out.properties && typeof out.properties === "object") {
      out.required = Object.keys(out.properties);
      out.additionalProperties = false;
    }
    return out;
  };
  return visit(z.toJSONSchema(schema, { io: "output" })) as JsonSchema;
}

type OpenAIUsage = {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
};

type OpenAIResponse = {
  model?: string;
  status?: string;
  error?: { message?: string; code?: string } | null;
  incomplete_details?: { reason?: string } | null;
  usage?: OpenAIUsage;
  output?: { type: string; content?: { type: string; text?: string; refusal?: string }[] }[];
};

/** Cached input is reported inside input_tokens; split it out to match the shared usage shape. */
export function toUsage(usage: OpenAIUsage | undefined): TokenUsage | null {
  if (!usage) return null;
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: Math.max(0, (usage.input_tokens ?? 0) - cached),
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}

/** Maps an HTTP status (null for network errors) to a message that says what to do next. */
export function describeOpenAIError(status: number | null, model: string, detail?: string) {
  const suffix = detail ? `: ${detail}` : "";
  switch (status) {
    case null:
      return "Could not reach the OpenAI API. Check your internet connection.";
    case 400:
      return `OpenAI rejected the request${suffix}`;
    case 401:
      return "The OpenAI API key was rejected. Check OPENAI_API_KEY in .env.local.";
    case 403:
      return `This API key is not allowed to use ${model}. Check your OpenAI project permissions.`;
    case 404:
      return `Model "${model}" was not found. Check OPENAI_MODEL in .env.local.`;
    case 429:
      return detail?.toLowerCase().includes("quota")
        ? "Your OpenAI account is out of credit. Add billing in the OpenAI dashboard, then retry."
        : "OpenAI rate limit reached. Wait a minute and try again.";
    default:
      return status >= 500
        ? "OpenAI is temporarily unavailable. Try again in a few minutes."
        : `OpenAI API error ${status}${suffix}`;
  }
}

/** Why a finished response has no usable output, or null when it has one. */
function describeStop(response: OpenAIResponse, request: StructuredRequest): string | null {
  const { subject } = request;
  const refusal = response.output
    ?.flatMap((item) => item.content ?? [])
    .find((part) => part.type === "refusal")?.refusal;
  if (refusal) return `GPT declined to write this ${subject} (${refusal.slice(0, 200)}). ${request.refusalHint ?? "Try again."}`;
  if (response.status === "incomplete") {
    return response.incomplete_details?.reason === "max_output_tokens"
      ? `The ${subject} was cut off before it was finished. ${request.cutOffHint ?? "Try again."}`
      : `GPT stopped before finishing the ${subject} (${response.incomplete_details?.reason ?? "incomplete"}). Try again.`;
  }
  if (response.status === "failed") {
    return `OpenAI could not generate the ${subject}${response.error?.message ? `: ${response.error.message}` : ""}. Try again.`;
  }
  return null;
}

function outputText(response: OpenAIResponse) {
  return (response.output ?? [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text")
    .map((part) => part.text ?? "")
    .join("");
}

/** Reads a server-sent event stream and returns the final response object. */
async function readFinalResponse(body: ReadableStream<Uint8Array>): Promise<OpenAIResponse | null> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let final: OpenAIResponse | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary: number;
    while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, "");
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      const event = JSON.parse(data) as { type?: string; response?: OpenAIResponse; message?: string };
      if (event.type === "error") throw new Error(event.message ?? "OpenAI stream error");
      if (
        event.response &&
        (event.type === "response.completed" || event.type === "response.incomplete" || event.type === "response.failed")
      ) {
        final = event.response;
      }
    }
  }
  return final;
}

type StoryRequest = {
  model: string;
  effort: OpenAIEffort;
  system: string;
  user: string;
};

type StructuredRequest = StoryRequest & {
  maxOutputTokens: number;
  /** Used in messages, e.g. "Short analysis". */
  subject: string;
  /** The json_schema format name (letters, digits, _ and - only). */
  name: string;
  refusalHint?: string;
  cutOffHint?: string;
};

export type OpenAIOptions = {
  apiKey: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Total tries for rate limits, 5xx and network errors before the stream starts. */
  maxAttempts?: number;
};

async function errorDetail(response: Response) {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message?.slice(0, 300);
  } catch {
    return undefined; // Non-JSON error body.
  }
}

/** Rate limits and outages are worth another try; an exhausted quota is not. */
function isRetryable(status: number | null, detail?: string) {
  if (status === null || status >= 500) return true;
  return status === 429 && !detail?.toLowerCase().includes("quota");
}

export async function runOpenAIStoryGeneration(options: OpenAIOptions, request: StoryRequest): Promise<GenerationResult> {
  const result = await runOpenAIStructuredGeneration(
    options,
    {
      ...request,
      maxOutputTokens: STORY_MAX_OUTPUT_TOKENS,
      subject: "story",
      name: "story",
      refusalHint: "Try rewording the brief.",
      cutOffHint: "Try a shorter target duration.",
    },
    storyContentSchema,
  );
  if (!result.ok) return result;
  const { data, ...rest } = result;
  return { ...rest, content: data };
}

/** One strict structured-output request, validated against a Zod schema. */
export async function runOpenAIStructuredGeneration<S extends z.ZodType>(
  options: OpenAIOptions,
  request: StructuredRequest,
  schema: S,
): Promise<StructuredResult<z.infer<S>>> {
  const { subject } = request;
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const fetchImpl = options.fetch ?? fetch;
  const failed = (message: string, usage: TokenUsage | null = null, model = request.model): StructuredResult<z.infer<S>> => ({
    ok: false,
    model,
    usage,
    durationMs: elapsed(),
    message,
  });

  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = options.maxAttempts ?? 3;
  const body = JSON.stringify({
    model: request.model,
    instructions: request.system,
    input: request.user,
    max_output_tokens: request.maxOutputTokens,
    reasoning: { effort: request.effort },
    text: {
      format: { type: "json_schema", name: request.name, strict: true, schema: toStrictJsonSchema(schema) },
    },
    // Nothing is kept on OpenAI's side; the app stores every result itself.
    store: false,
    stream: true,
  });

  let response: Response | null = null;
  for (let attempt = 1; ; attempt++) {
    let status: number | null = null;
    let detail: string | undefined;
    try {
      response = await fetchImpl(`${OPENAI_API_URL}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body,
      });
      if (response.ok && response.body) break;
      status = response.status;
      detail = await errorDetail(response);
    } catch (error) {
      if (attempt >= maxAttempts) console.error(`OpenAI ${subject} failed`, error);
    }
    if (attempt >= maxAttempts || !isRetryable(status, detail)) {
      return failed(describeOpenAIError(status, request.model, detail));
    }
    await sleep(1000 * 2 ** (attempt - 1));
  }

  if (!response?.body) return failed(describeOpenAIError(null, request.model));
  let final: OpenAIResponse | null;
  try {
    final = await readFinalResponse(response.body);
  } catch (error) {
    console.error(`OpenAI ${subject} stream failed`, error);
    return failed(`The connection to OpenAI broke off while the ${subject} was being written. Try again.`);
  }
  if (!final) return failed(`OpenAI ended the response without a ${subject}. Try again.`);

  const usage = toUsage(final.usage);
  const model = final.model ?? request.model;
  const stopped = describeStop(final, request);
  if (stopped) return failed(stopped, usage, model);

  const text = outputText(final);
  if (!text.trim()) return failed(`GPT returned an empty ${subject}. Try generating again.`, usage, model);
  const unexpected = `GPT returned the ${subject} in an unexpected format. Try generating again.`;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return failed(unexpected, usage, model);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    console.error(`OpenAI ${subject} did not match the schema`, parsed.error.issues.slice(0, 5));
    return failed(unexpected, usage, model);
  }
  return { ok: true, model, usage, durationMs: elapsed(), data: parsed.data as z.infer<S> };
}

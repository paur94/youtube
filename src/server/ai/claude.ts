import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";

import type { TokenUsage } from "@/lib/ai-usage";
import { storyContentSchema, type StoryContent } from "@/lib/stories";

// The API key is read from the server environment only. Nothing in this module may be
// imported by a client component ("server-only" makes that a build error).

export const DEFAULT_MODEL = "claude-opus-5-5";
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

const MAX_OUTPUT_TOKENS = 64_000;

export function getClaudeConfig() {
  const effort = process.env.ANTHROPIC_EFFORT?.trim() as Effort | undefined;
  return {
    configured: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
    model: process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL,
    effort: effort && EFFORT_LEVELS.includes(effort) ? effort : ("medium" as Effort),
  };
}

let cachedClient: Anthropic | undefined;

export function getClaudeClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return null;
  cachedClient ??= new Anthropic({ apiKey });
  return cachedClient;
}

export const NOT_CONFIGURED_MESSAGE =
  "Claude is not configured. Add ANTHROPIC_API_KEY to .env.local and restart the dev server.";

export type GenerationResult = {
  model: string;
  usage: TokenUsage | null;
  durationMs: number;
} & ({ ok: true; content: StoryContent } | { ok: false; message: string });

type StoryRequest = {
  model: string;
  effort: Effort;
  system: string;
  user: string;
};

function toUsage(usage: Anthropic.Beta.BetaUsage | undefined): TokenUsage | null {
  if (!usage) return null;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

function describeStop(message: Anthropic.Beta.BetaMessage): string | null {
  switch (message.stop_reason) {
    case "refusal": {
      const category = message.stop_details?.category;
      return `Claude declined to write this story${category ? ` (safety category: ${category})` : ""}. Try rewording the brief.`;
    }
    case "max_tokens":
      return "The story was cut off before it was finished. Try a shorter target duration.";
    default:
      return null;
  }
}

/** Maps SDK errors to messages that tell the user what to do next. Most specific first. */
export function describeClaudeError(error: unknown, model: string): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return "The Anthropic API key was rejected. Check ANTHROPIC_API_KEY in .env.local.";
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return `This API key is not allowed to use ${model}. Check your Anthropic workspace permissions.`;
  }
  if (error instanceof Anthropic.NotFoundError) {
    return `Model "${model}" was not found. Check ANTHROPIC_MODEL in .env.local.`;
  }
  if (error instanceof Anthropic.RateLimitError) {
    return "Anthropic rate limit reached. Wait a minute and try again.";
  }
  if (error instanceof Anthropic.BadRequestError) {
    return `Anthropic rejected the request: ${error.message}`;
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return "The request to Claude timed out. Try again.";
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return "Could not reach the Anthropic API. Check your internet connection.";
  }
  if (error instanceof Anthropic.APIError) {
    // 5xx and 529 (overloaded) land here after the SDK's automatic retries.
    if (error.status && error.status >= 500) {
      return "Claude is temporarily unavailable. Try again in a few minutes.";
    }
    return `Anthropic API error${error.status ? ` ${error.status}` : ""}: ${error.message}`;
  }
  if (error instanceof Anthropic.AnthropicError) {
    return "Claude returned a story in an unexpected format. Try generating again.";
  }
  return "Story generation failed unexpectedly. Try again.";
}

export async function runStoryGeneration(
  client: Anthropic,
  request: StoryRequest,
): Promise<GenerationResult> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;

  // Streaming avoids HTTP timeouts on long outputs; finalMessage() collects the whole response.
  const stream = client.beta.messages.stream({
    model: request.model,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: request.system,
    messages: [{ role: "user", content: request.user }],
    output_config: { effort: request.effort, format: betaZodOutputFormat(storyContentSchema) },
    // If the model declines for policy reasons, the API retries on its default fallback model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  });

  try {
    const message = await stream.finalMessage();
    const base = { model: message.model, usage: toUsage(message.usage), durationMs: elapsed() };

    const stopMessage = describeStop(message);
    if (stopMessage) return { ...base, ok: false, message: stopMessage };
    if (!message.parsed_output) {
      return { ...base, ok: false, message: "Claude returned an empty story. Try generating again." };
    }
    return { ...base, ok: true, content: message.parsed_output };
  } catch (error) {
    // A refusal or truncated output fails structured-output parsing; the snapshot still has
    // the stop reason and the tokens that were billed.
    const snapshot = stream.currentMessage;
    const stopMessage = snapshot ? describeStop(snapshot) : null;
    if (!stopMessage) console.error("Story generation failed", error);
    return {
      ok: false,
      model: snapshot?.model ?? request.model,
      usage: toUsage(snapshot?.usage),
      durationMs: elapsed(),
      message: stopMessage ?? describeClaudeError(error, request.model),
    };
  }
}

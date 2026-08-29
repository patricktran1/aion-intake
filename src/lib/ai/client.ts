import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_MODEL, estimateCostUsd } from "./cost";

/**
 * Thin wrapper over the Anthropic SDK.
 *
 * Two properties matter here:
 *  - If no key is configured the whole product still works. `isModelEnabled()`
 *    is false and every caller takes its deterministic path.
 *  - Every call reports tokens so cost per intake is measured, not guessed.
 */

export interface ModelCallResult<T> {
  ok: boolean;
  data: T | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  error?: string;
}

let client: Anthropic | null = null;

export function modelName(): string {
  return process.env.AION_MODEL || DEFAULT_MODEL;
}

export function isModelEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      maxRetries: 1,
      timeout: 20_000,
    });
  }
  return client;
}

/**
 * Reduce a provider error to a fixed vocabulary before it can be recorded.
 *
 * SDK messages can carry URLs, request ids and fragments of configuration.
 * Analytics never needs any of that — it needs to know that calls are failing
 * and roughly why.
 */
export function errorReason(err: unknown): string {
  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  if (message.includes("timeout") || message.includes("timed out")) return "timeout";
  if (message.includes("429") || message.includes("rate")) return "rate_limit";
  if (message.includes("401") || message.includes("403") || message.includes("api key")) return "auth";
  if (message.includes("overload") || message.includes("529")) return "overloaded";
  if (message.includes("econn") || message.includes("network") || message.includes("fetch")) return "network";
  if (message.includes("500") || message.includes("502") || message.includes("503")) return "provider_error";
  return "other";
}

const empty = <T>(error: string): ModelCallResult<T> => ({
  ok: false,
  data: null,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  error,
});

/** Structured extraction via a tool call. Returns null data on any failure. */
export async function callTool<T>(args: {
  system: string;
  user: string;
  tool: { name: string; description: string; input_schema: Record<string, unknown> };
  maxTokens?: number;
}): Promise<ModelCallResult<T>> {
  if (!isModelEnabled()) return empty("model_disabled");
  const model = modelName();
  try {
    const res = await getClient().messages.create({
      model,
      max_tokens: args.maxTokens ?? 700,
      system: args.system,
      tools: [args.tool as never],
      tool_choice: { type: "tool", name: args.tool.name },
      messages: [{ role: "user", content: args.user }],
    });
    const block = res.content.find((c) => c.type === "tool_use");
    const inputTokens = res.usage.input_tokens;
    const outputTokens = res.usage.output_tokens;
    const costUsd = estimateCostUsd(model, inputTokens, outputTokens);
    if (!block || block.type !== "tool_use") {
      return { ok: false, data: null, inputTokens, outputTokens, costUsd, error: "no_tool_use" };
    }
    return { ok: true, data: block.input as T, inputTokens, outputTokens, costUsd };
  } catch (err) {
    return empty(errorReason(err));
  }
}

/** Plain text generation, used for the draft HPI. */
export async function callText(args: {
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<ModelCallResult<string>> {
  if (!isModelEnabled()) return empty("model_disabled");
  const model = modelName();
  try {
    const res = await getClient().messages.create({
      model,
      max_tokens: args.maxTokens ?? 700,
      system: args.system,
      messages: [{ role: "user", content: args.user }],
    });
    const text = res.content
      .filter((c) => c.type === "text")
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("")
      .trim();
    const inputTokens = res.usage.input_tokens;
    const outputTokens = res.usage.output_tokens;
    return {
      ok: text.length > 0,
      data: text || null,
      inputTokens,
      outputTokens,
      costUsd: estimateCostUsd(model, inputTokens, outputTokens),
    };
  } catch (err) {
    return empty(errorReason(err));
  }
}

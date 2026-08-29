/**
 * Cost instrumentation.
 *
 * The product may be given away to dermatologists, so "what does one completed
 * intake cost us" is a first-class number, not an afterthought. Prices are per
 * million tokens and are checked into source so a rate change is a visible diff.
 */
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

export const PRICING: Record<string, ModelPricing> = {
  "claude-haiku-4-5-20251001": { inputPerMTok: 1, outputPerMTok: 5 },
  "claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
};

export const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

export function priceFor(model: string): ModelPricing {
  return PRICING[model] ?? PRICING[DEFAULT_MODEL];
}

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = priceFor(model);
  return (inputTokens * p.inputPerMTok + outputTokens * p.outputPerMTok) / 1_000_000;
}

export function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

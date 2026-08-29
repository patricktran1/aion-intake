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
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
  "claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10 },
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
  // Older dated form of the Haiku id, kept so an existing AION_MODEL setting
  // still prices correctly rather than silently falling back to the default.
  "claude-haiku-4-5-20251001": { inputPerMTok: 1, outputPerMTok: 5 },
};

/**
 * One small model does everything. Note the id carries no date suffix — the
 * dated variants are a different, older addressing form.
 */
export const DEFAULT_MODEL = "claude-haiku-4-5";

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

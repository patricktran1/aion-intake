import { summarize } from "@/lib/analytics";
import { json } from "@/lib/api";
import { isModelEnabled, modelName } from "@/lib/ai/client";

/**
 * The whole analytics surface: one JSON endpoint. Deliberately not a dashboard.
 * See METRICS.md for what each number is supposed to tell us.
 */
export async function GET() {
  return json({
    ...summarize(),
    ai_mode: isModelEnabled() ? "model" : "deterministic",
    model: isModelEnabled() ? modelName() : null,
  });
}

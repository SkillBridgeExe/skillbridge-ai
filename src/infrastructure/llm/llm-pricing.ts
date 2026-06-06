/**
 * Best-effort USD cost estimation for LLM calls (price per 1,000,000 tokens, input/output split).
 *
 * ⚠️ PRICES ARE PLACEHOLDERS — replace with the CONFIRMED published prices for your account.
 * They give DIRECTIONAL cost visibility (budget watch / per-request telemetry), NOT billing
 * accuracy. A model absent from the table returns `undefined`, so a cost is NEVER fabricated for
 * an unknown model — `ai_requests.estimated_cost` stays NULL rather than storing a wrong number.
 */
interface ModelPrice {
  inputPer1M: number;
  outputPer1M: number;
}

const PRICES: Record<string, ModelPrice> = {
  // ── text generation (chat / complete) ──
  'gpt-5.4-mini': { inputPer1M: 0.25, outputPer1M: 2.0 },
  'gpt-5.4': { inputPer1M: 1.25, outputPer1M: 10.0 },
  'gpt-5.5': { inputPer1M: 2.5, outputPer1M: 20.0 },
  'gemini-2.5-flash': { inputPer1M: 0.3, outputPer1M: 2.5 },
  // ── embeddings (no output tokens) ──
  'text-embedding-3-large': { inputPer1M: 0.13, outputPer1M: 0 },
  'text-embedding-3-small': { inputPer1M: 0.02, outputPer1M: 0 },
};

/**
 * USD cost for one completion. Returns `undefined` when the model has no price entry
 * (never guesses). Rounded to 6dp to fit `ai_requests.estimated_cost numeric(., 6)`.
 */
export function estimateCostUsd(
  modelCode: string,
  promptTokens: number,
  completionTokens: number,
): number | undefined {
  const p = PRICES[modelCode] ?? PRICES[(modelCode ?? '').toLowerCase()];
  if (!p) return undefined;
  const cost =
    (promptTokens / 1_000_000) * p.inputPer1M + (completionTokens / 1_000_000) * p.outputPer1M;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

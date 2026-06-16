/**
 * Phase 2 extraction-model toggle (deterministic-first). Pure, no I/O.
 *
 * When an override model is configured (`CV_JD_MATCH_EXTRACTION_MODEL`), the cv-jd-match extraction
 * call uses it with `temperature: 0` (+ optional seed) for determinism — a non-reasoning model
 * (e.g. gpt-4o-mini) honors these, unlike the reasoning default. When no override is set the legacy
 * default model + `temperature: 0.1` is returned, so the toggle is OFF by default and prod behavior
 * is byte-identical until an operator sets the env (same safe-default pattern as the v2 template flag).
 *
 * This does NOT change the scoring formula; it only changes which model/params produce the extraction.
 * Switching the model is score-changing (different extraction) — shipped with an honest drift report.
 */
export interface ExtractionModelParams {
  model: string;
  temperature: number;
  seed?: number;
}

export function resolveExtractionModel(opts: {
  defaultModel: string;
  overrideModel?: string | null;
  seed?: number;
}): ExtractionModelParams {
  const override = opts.overrideModel?.trim();
  if (override) {
    return {
      model: override,
      temperature: 0,
      ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    };
  }
  return { model: opts.defaultModel, temperature: 0.1 };
}

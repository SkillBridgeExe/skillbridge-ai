/**
 * Deterministic input-quality gate for CvRewriteService.
 *
 * Garbage must never reach the LLM — it burns platform cost AND the user's own quota.
 * Platform records usage only after a successful rewrite; a gate rejection before
 * cache/LLM/tracing ensures zero quota impact on junk inputs.
 *
 * The heuristics live in the shared `assessTextQuality` (common/services/text-quality) —
 * the SAME core also gates uploaded CV text (cv-review) and pasted JD text (cv-jd-match).
 */
import { assessTextQuality } from '../../common/services/text-quality';

export interface InputQualityVerdict {
  ok: boolean;
  reason?: 'INSUFFICIENT_CONTEXT';
}

/** Rewrite fields are short — require >=4 meaningful tokens OR >=25 meaningful chars. */
export function assessRewriteInput(text: string): InputQualityVerdict {
  const v = assessTextQuality(text, { minMeaningfulTokens: 4, minMeaningfulChars: 25 });
  return v.ok ? { ok: true } : { ok: false, reason: 'INSUFFICIENT_CONTEXT' };
}

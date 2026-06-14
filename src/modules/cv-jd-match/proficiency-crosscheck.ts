import {
  Proficiency,
  PROFICIENCY_TO_LEVEL,
  qualifierToProficiency,
} from '../../common/services/proficiency-calibration';
import type { RawCvSkill } from './skill-diff.service';

/**
 * Telemetry ONLY. Compares the LLM-emitted `proficiency_hint` against the qualifier WORD found in a
 * CV skill's `evidence_text`, and flags skills where the LLM claimed a HIGHER proficiency than the
 * evidence supports. It is a read-only signal for prompt curation — it NEVER alters the hint, the
 * level, or the score.
 *
 * `capForEvidence` is intentionally NOT used here: `RawCvSkill` has no evidence-TYPE field
 * (demonstrated / listed_only / mentioned), so the cap cannot be derived from production data
 * (degradation documented in the design spec §3). The check no-ops when no evidence/qualifier is
 * present or the hint is missing/invalid.
 */

export interface InflationFinding {
  /** The CV skill's raw token (a skill name, not free CV prose) — PII-safe to log. */
  canonical_or_raw: string;
  llm_hint: Proficiency;
  qualifier_proficiency: Proficiency;
}

const VALID_PROFICIENCIES: ReadonlySet<string> = new Set<Proficiency>([
  'BEGINNER',
  'NOVICE',
  'INTERMEDIATE',
  'ADVANCED',
  'EXPERT',
]);

export function detectProficiencyInflation(cvSkillsRaw: RawCvSkill[]): InflationFinding[] {
  const findings: InflationFinding[] = [];
  for (const skill of cvSkillsRaw ?? []) {
    if (!skill.evidence_text) continue;
    const qualifier = qualifierToProficiency(skill.evidence_text);
    if (qualifier === null) continue;
    const hintUpper = String(skill.proficiency_hint ?? '').toUpperCase();
    if (!VALID_PROFICIENCIES.has(hintUpper)) continue;
    const hint = hintUpper as Proficiency;
    if (PROFICIENCY_TO_LEVEL[hint] > PROFICIENCY_TO_LEVEL[qualifier]) {
      findings.push({
        canonical_or_raw: skill.name,
        llm_hint: hint,
        qualifier_proficiency: qualifier,
      });
    }
  }
  return findings;
}

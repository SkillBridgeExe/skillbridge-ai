import {
  Proficiency,
  PROFICIENCY_TO_LEVEL,
  qualifierToProficiency,
} from '../../common/services/proficiency-calibration';
import type { RawCvSkill } from './skill-diff.service';

/**
 * Telemetry ONLY. Compares the LLM-emitted `proficiency_hint` against the qualifier WORD found in a
 * CV skill's `evidence_text`, and flags skills where the LLM claimed a HIGHER proficiency than the
 * evidence supports. Read-only signal for prompt curation — NEVER alters the hint, level, or score.
 *
 * PRIVACY: a finding carries ONLY the two proficiency ENUMS. The raw skill name (`RawCvSkill.name`)
 * is LLM-extracted free text that can contain PII (a misparsed line, an email, a person's name), so
 * it is deliberately NOT returned or logged. `summarizeInflation` reduces findings to enum-pair
 * counts (e.g. "ADVANCED>NOVICE=2") — the only thing safe to log.
 *
 * `capForEvidence` is intentionally NOT used here: `RawCvSkill` has no evidence-TYPE field
 * (demonstrated / listed_only / mentioned), so the cap cannot be derived from production data
 * (degradation documented in the design spec §3). The check no-ops when no evidence/qualifier is
 * present or the hint is missing/invalid.
 */

export interface InflationFinding {
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
      findings.push({ llm_hint: hint, qualifier_proficiency: qualifier });
    }
  }
  return findings;
}

/**
 * Reduce findings to a PII-safe, log-safe summary of enum-pair counts, e.g.
 * "ADVANCED>NOVICE=2, EXPERT>BEGINNER=1". Enums + counts ONLY — no skill names, no evidence text.
 */
export function summarizeInflation(findings: InflationFinding[]): string {
  const counts = new Map<string, number>();
  for (const f of findings) {
    const key = `${f.llm_hint}>${f.qualifier_proficiency}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => `${key}=${count}`)
    .join(', ');
}

/**
 * Gap Engine eval — golden cases for the unified GapItem builder. Fully OFFLINE (no LLM, no DB):
 * cv_skills + jd_requirements flow through the REAL SkillNormalizer → SkillDiffService, then a
 * fixture evidence ledger is overlaid and buildGapItems() runs. This is the GATE for every change
 * to gap mapping / severity (mirrors eval:match for scoring).
 *
 *   pnpm eval:gap
 *
 * data/eval-gap-cases.json case shape: { id, target_role, cv_skills[{name,proficiency_hint}],
 *   jd_requirements?[...], ledger_listed_only?[], ledger_demonstrated?[], expect[{canonical,
 *   cv_status, fixability?, evidence_risk?}] }.
 *
 * Data sanity: every cv_skills name MUST normalize (else the measurement is corrupt) — violations
 * fail the run. Any expectation miss fails the run (golden cases must hold).
 */
import * as fs from 'fs';
import * as path from 'path';
import { SkillTaxonomyService } from '../common/services/skill-taxonomy.service';
import { SkillNormalizerService } from '../common/services/skill-normalizer.service';
import { RoleRubricService } from '../common/services/role-rubric.service';
import {
  SkillDiffService,
  RawCvSkill,
  DiffResult,
} from '../modules/cv-jd-match/skill-diff.service';
import { CvJdMatchParsedResponse } from '../modules/cv-jd-match/dto/cv-jd-match-response.dto';
import { EvidenceLedger } from '../common/services/evidence-ledger';
import { buildGapItems } from '../modules/gap-engine/gap-item';

interface GapCase {
  id: string;
  target_role: string;
  cv_skills: Array<{ name: string; proficiency_hint: string }>;
  jd_requirements?: Array<{ name: string; importance_hint?: string; required_level_hint?: string }>;
  ledger_listed_only?: string[];
  ledger_demonstrated?: string[];
  /** canonical → pct_of_postings (0-100), overlaid as the market-demand input. Optional; when present
   *  it drives severity ranking (lets a case test market-tilt — e.g. two equal gaps ordered by demand). */
  market_demand?: Record<string, number>;
  expect: Array<{
    canonical: string;
    cv_status: string;
    fixability?: string;
    evidence_risk?: string;
  }>;
  /** Canonicals in REQUIRED severity order (highest first). The PR2 ranking gate: asserts these
   *  canonicals appear in this exact order in the EMITTED items[] (so it catches near-ties that round
   *  to equal public severity but must still rank by raw severity), and that their severities are
   *  non-increasing. Supply `market_demand` to exercise market-driven ordering. */
  expect_severity_order?: string[];
}

/** A fixture ledger from the case (only the fields buildGapItems reads: strength + evidence_gap). */
function buildFixtureLedger(c: GapCase): EvidenceLedger | null {
  const listed = c.ledger_listed_only ?? [];
  const demonstrated = c.ledger_demonstrated ?? [];
  if (listed.length === 0 && demonstrated.length === 0) return null;
  return {
    evidence_gap: [...listed],
    items: [
      ...listed.map((s) => ({
        skill_canonical: s,
        display_name: s,
        sources: [],
        strength: 'listed_only' as const,
        most_recent_year: null,
      })),
      ...demonstrated.map((s) => ({
        skill_canonical: s,
        display_name: s,
        sources: [{ kind: 'experience' as const, ref: 'fixture', recency_year: 2025 }],
        strength: 'demonstrated' as const,
        most_recent_year: 2025,
      })),
    ],
  };
}

async function main(): Promise<void> {
  const file = path.join(process.cwd(), 'data', 'eval-gap-cases.json');
  const { cases } = JSON.parse(fs.readFileSync(file, 'utf-8')) as { cases: GapCase[] };

  const taxonomy = new SkillTaxonomyService();
  await taxonomy.onModuleInit();
  const normalizer = new SkillNormalizerService(taxonomy);
  const rubrics = new RoleRubricService();
  await rubrics.onModuleInit();
  const diffSvc = new SkillDiffService(normalizer, rubrics);

  console.log(`\nGap-engine eval — ${cases.length} cases (offline, 0 LLM calls)\n`);

  const dataErrors: string[] = [];
  const misses: string[] = [];

  for (const c of cases) {
    const res: DiffResult = diffSvc.diff({
      cv_skills_raw: c.cv_skills as RawCvSkill[],
      target_role: c.target_role,
      ...(c.jd_requirements ? { jd_requirements_raw: c.jd_requirements } : {}),
    });

    if (res.unnormalized_cv_skills.length > 0) {
      dataErrors.push(
        `  ${c.id}: unnormalized cv_skills [${res.unnormalized_cv_skills.map((u) => u.raw_input).join(', ')}]`,
      );
    }

    // buildGapItems only reads these fields off the parsed response — adapt the DiffResult.
    const match = {
      matched_skills: res.matched_skills,
      partial_skills: res.partial_skills,
      missing_skills: res.missing_skills,
      source_of_requirements: res.requirements_source,
      target_role: c.target_role,
    } as unknown as CvJdMatchParsedResponse;

    const items = buildGapItems({
      match,
      ledger: buildFixtureLedger(c),
      marketDemand: c.market_demand ? new Map(Object.entries(c.market_demand)) : null,
    });
    const byCanonical = new Map(items.map((g) => [g.canonical_name, g]));

    const lines: string[] = [];
    for (const e of c.expect) {
      const g = byCanonical.get(e.canonical);
      if (!g) {
        misses.push(`  ${c.id}: expected gap "${e.canonical}" not produced`);
        continue;
      }
      const checks: Array<[string, string | undefined, string]> = [
        ['cv_status', e.cv_status, g.cv_status],
        ['fixability', e.fixability, g.fixability],
        ['evidence_risk', e.evidence_risk, g.evidence_risk],
      ];
      for (const [field, want, got] of checks) {
        if (want !== undefined && want !== got) {
          misses.push(`  ${c.id}: ${e.canonical}.${field} = "${got}", expected "${want}"`);
        }
      }
      lines.push(`${e.canonical}=${g.cv_status}/${g.fixability}`);
    }

    // Severity ranking gate (PR2): the listed canonicals must appear in the EMITTED items[] in this
    // order (the primary check — it catches near-ties that round to equal public severity but must
    // still rank by raw severity, e.g. market-demand tilt), and their severities must be non-increasing.
    if (c.expect_severity_order) {
      const positions = c.expect_severity_order.map((canon) => ({
        canon,
        idx: items.findIndex((g) => g.canonical_name === canon),
        sev: byCanonical.get(canon)?.severity,
      }));
      const absent = positions.find((p) => p.idx < 0);
      if (absent) {
        misses.push(`  ${c.id}: severity-order canonical "${absent.canon}" not produced`);
      } else {
        for (let i = 1; i < positions.length; i++) {
          if (positions[i - 1].idx > positions[i].idx) {
            misses.push(
              `  ${c.id}: emitted order violated — ${positions[i - 1].canon}(#${positions[i - 1].idx}) after ${positions[i].canon}(#${positions[i].idx})`,
            );
          }
          if ((positions[i - 1].sev as number) < (positions[i].sev as number)) {
            misses.push(
              `  ${c.id}: severity order violated — ${positions[i - 1].canon}(${positions[i - 1].sev}) < ${positions[i].canon}(${positions[i].sev})`,
            );
          }
        }
      }
      lines.push(`order[${positions.map((p) => `${p.canon}#${p.idx}:${p.sev}`).join(' > ')}]`);
    }
    console.log(`${c.id.padEnd(38)} ${lines.join('  ')}`);
  }

  console.log('\n=== Summary ===');
  if (dataErrors.length)
    console.log(`DATA ERRORS (corrupt measurement):\n${dataErrors.join('\n')}`);
  if (misses.length) console.log(`Expectation misses:\n${misses.join('\n')}`);
  const fail = dataErrors.length > 0 || misses.length > 0;
  console.log(`\nVerdict: ${fail ? 'FAIL ❌' : 'PASS ✅'}\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('\neval-gap failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});

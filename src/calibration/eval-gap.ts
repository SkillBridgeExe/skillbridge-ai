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
  expect: Array<{
    canonical: string;
    cv_status: string;
    fixability?: string;
    evidence_risk?: string;
  }>;
  /** Canonicals in REQUIRED severity order (highest first). Asserts severity(a) >= severity(b) >= ...
   *  — the PR2 ranking gate (market_demand is null in eval-gap, so this isolates importance/status/evidence). */
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

    const items = buildGapItems({ match, ledger: buildFixtureLedger(c) });
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

    // Severity ranking gate (PR2): the emitted severities must be non-increasing in the listed order.
    if (c.expect_severity_order) {
      const sevs = c.expect_severity_order.map((canon) => ({
        canon,
        sev: byCanonical.get(canon)?.severity,
      }));
      const missing = sevs.find((s) => s.sev === undefined);
      if (missing) {
        misses.push(`  ${c.id}: severity-order canonical "${missing.canon}" not produced`);
      } else {
        for (let i = 1; i < sevs.length; i++) {
          if ((sevs[i - 1].sev as number) < (sevs[i].sev as number)) {
            misses.push(
              `  ${c.id}: severity order violated — ${sevs[i - 1].canon}(${sevs[i - 1].sev}) < ${sevs[i].canon}(${sevs[i].sev})`,
            );
          }
        }
      }
      lines.push(`order[${sevs.map((s) => `${s.canon}:${s.sev}`).join(' > ')}]`);
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

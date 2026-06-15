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
import { normalizeJdDimensions, RawJdDimension } from '../modules/gap-engine/jd-dimensions';
import {
  BUCKET_RANK,
  JOB_LEVEL_RANK,
  CvSeniority,
  SeniorityBucket,
  Confidence,
} from '../common/services/seniority';
import {
  Cefr,
  CEFR_RANK,
  DegreeLevel,
  DEGREE_RANK,
  CvProfileSignals,
  SignalConfidence,
} from '../common/services/cv-profile-signals';

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
  /** PR3: raw non-skill JD dimensions (LLM-shaped) — hardened via normalizeJdDimensions then graded
   *  (only `seniority` is graded). Pair with `cv_seniority` to test the seniority gap end-to-end. */
  jd_dimensions?: RawJdDimension[];
  /** PR3: fixture CV seniority (the deriveCvSeniority output) — the CV-side signal for the gap. */
  cv_seniority?: { bucket: string; est_years?: number | null; confidence: string };
  /** PR3c: fixture CV profile signals (deriveCvProfileSignals output) — the CV-side input for grading
   *  language/education/domain. Omit a sub-field to model "CV silent" on that dimension. */
  cv_profile_signals?: {
    english?: { cefr: string; confidence?: string };
    education?: { level: string | null; field?: string | null; confidence?: string };
    domain?: { domains: string[]; confidence?: string };
    work_mode?: { mode: string; confidence?: string };
  };
  expect: Array<{
    canonical: string;
    cv_status: string;
    fixability?: string;
    evidence_risk?: string;
  }>;
  /** Canonicals that must NOT appear in the emitted items[] — the honest-omission gate (e.g. a
   *  seniority dim with no/low-confidence CV signal must produce NO gap, never a fabricated one). */
  expect_absent?: string[];
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

    // PR3 non-skill dims: harden raw fixtures through the REAL coercer; build a fixture CV seniority.
    const jdDimensions = c.jd_dimensions ? normalizeJdDimensions(c.jd_dimensions) : null;
    let cvSeniority: CvSeniority | null = null;
    if (c.cv_seniority) {
      const bucket = c.cv_seniority.bucket as SeniorityBucket;
      if (!(bucket in BUCKET_RANK)) {
        dataErrors.push(
          `  ${c.id}: cv_seniority.bucket "${c.cv_seniority.bucket}" is not a SeniorityBucket`,
        );
      }
      cvSeniority = {
        bucket,
        est_years: c.cv_seniority.est_years ?? null,
        confidence: c.cv_seniority.confidence as Confidence,
        signals: [],
      };
    }
    // PR3c: build the fixture CV profile signals (the deriveCvProfileSignals output). Omit a sub-field
    // to model CV silence on that dimension. Data-sanity validates the enums so a typo can't pass.
    let cvProfileSignals: CvProfileSignals | null = null;
    const cps = c.cv_profile_signals;
    if (cps) {
      if (cps.english && !(cps.english.cefr in CEFR_RANK)) {
        dataErrors.push(
          `  ${c.id}: cv_profile_signals.english.cefr "${cps.english.cefr}" is not a CEFR level`,
        );
      }
      if (cps.education && cps.education.level !== null && !(cps.education.level in DEGREE_RANK)) {
        dataErrors.push(
          `  ${c.id}: cv_profile_signals.education.level "${String(cps.education.level)}" is not a DegreeLevel`,
        );
      }
      cvProfileSignals = {
        english: cps.english
          ? {
              cefr: cps.english.cefr as Cefr,
              source_kind: 'cefr',
              raw: '',
              confidence: (cps.english.confidence ?? 'high') as SignalConfidence,
              signals: [],
            }
          : null,
        education: cps.education
          ? {
              level: cps.education.level as DegreeLevel | null,
              field: cps.education.field ?? null,
              confidence: (cps.education.confidence ?? 'high') as SignalConfidence,
              signals: [],
            }
          : null,
        domain: cps.domain
          ? {
              domains: cps.domain.domains,
              confidence: (cps.domain.confidence ?? 'low') as SignalConfidence,
              signals: [],
            }
          : null,
        work_mode: cps.work_mode
          ? {
              mode: cps.work_mode.mode as 'remote' | 'hybrid' | 'onsite',
              confidence: (cps.work_mode.confidence ?? 'low') as SignalConfidence,
              signals: [],
            }
          : null,
      };
    }

    // Data sanity: a seniority fixture that PROVIDES a level_hint must coerce to a known rank, else it
    // would silently never grade (a missing level_hint is a deliberate omission case — allowed).
    for (const d of c.jd_dimensions ?? []) {
      if (
        d.dimension === 'seniority' &&
        typeof d.level_hint === 'string' &&
        d.level_hint.trim() &&
        !(d.level_hint.trim().toUpperCase() in JOB_LEVEL_RANK)
      ) {
        dataErrors.push(
          `  ${c.id}: seniority level_hint "${String(d.level_hint)}" is not a JOB_LEVEL_RANK key`,
        );
      }
    }

    const items = buildGapItems({
      match,
      ledger: buildFixtureLedger(c),
      marketDemand: c.market_demand ? new Map(Object.entries(c.market_demand)) : null,
      jdDimensions,
      cvSeniority,
      cvProfileSignals,
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

    // Honest-omission gate: these canonicals must NOT be produced (e.g. no/low-confidence CV signal).
    for (const canon of c.expect_absent ?? []) {
      if (byCanonical.has(canon)) {
        misses.push(`  ${c.id}: "${canon}" must NOT be produced (honest omission), but it was`);
      } else {
        lines.push(`absent[${canon}]✓`);
      }
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

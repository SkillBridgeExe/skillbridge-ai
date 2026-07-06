/**
 * Golden-corpus eval — end-to-end persona cases through the REAL deterministic engines
 * (SkillNormalizer → SkillDiffService → buildGapItems → classifyFit → buildTailorChecklist).
 * Fully OFFLINE (no LLM, no DB). Where eval:gap gates the gap builder in isolation, this gates
 * the WHOLE value chain: score band, fit verdict, top gap, top tailor action, unnormalized
 * counts and cross-case score relations must all hold at once.
 *
 *   pnpm eval:golden
 *
 * data/golden-corpus-v1.json shape: { _bands: {band: [lo, hi]}, cases: [...] } — see GoldenCase.
 * Semantics the corpus relies on:
 *   - expected.top_gap_canonical: null  → EVERY produced gap must have severity 0 (no real gap).
 *   - expected.top_action_type:  null  → the tailor checklist must be EMPTY.
 *   - expected.relations: "a.score OP b.score" cross-case checks (>, >=, <, <=, ==).
 *   - keyword_frequency: fixture overlay on the parsed-match shape (buildTailorChecklist reads it).
 *   - unnormalized_{jd,cv}_count: expected counts for deliberately-unknown taxonomy inputs.
 *   - tags: ["edge_taxonomy"] exempts a case from the everything-must-normalize data-sanity gate.
 * Any expectation miss or data error fails the run (exit 1).
 */
import * as fs from 'fs';
import * as path from 'path';
import { SkillTaxonomyService } from '../common/services/skill-taxonomy.service';
import { SkillNormalizerService } from '../common/services/skill-normalizer.service';
import { RoleRubricService } from '../common/services/role-rubric.service';
import { SkillDiffService, RawCvSkill } from '../modules/cv-jd-match/skill-diff.service';
import {
  CvJdMatchParsedResponse,
  KeywordFrequency,
} from '../modules/cv-jd-match/dto/cv-jd-match-response.dto';
import { EvidenceLedger } from '../common/services/evidence-ledger';
import { buildGapItems } from '../modules/gap-engine/gap-item';
import { classifyFit } from '../modules/gap-engine/fit-strategy';
import { buildTailorChecklist } from '../modules/cv-jd-match/tailor-checklist';

interface GoldenCase {
  id: string;
  persona: string;
  target_role?: string;
  target_band?: 'intern' | 'fresher' | 'mid';
  cv_skills: Array<{ name: string; proficiency_hint?: string; evidence_text?: string }>;
  jd_requirements?: Array<{ name: string; importance_hint?: string; required_level_hint?: string }>;
  ledger_listed_only?: string[];
  ledger_demonstrated?: string[];
  market_demand?: Record<string, number>;
  interview_signals?: Record<string, number>;
  keyword_frequency?: KeywordFrequency[];
  tags?: string[];
  expected: {
    match_band?: string;
    fit_verdict?: string;
    top_gap_canonical?: string | null;
    top_action_type?: string | null;
    relations?: string[];
    unnormalized_jd_count?: number;
    unnormalized_cv_count?: number;
  };
  rationale: string;
}

interface GoldenCorpus {
  _bands: Record<string, [number, number]>;
  cases: GoldenCase[];
}

/**
 * Fixture ledger mirroring what the corpus was calibrated against: demonstrated skills carry a
 * realistic quoted source; listed-only skills appear ONLY in evidence_gap (no items[] entry).
 */
function buildFixtureLedger(c: GoldenCase): EvidenceLedger | undefined {
  if (!c.ledger_listed_only && !c.ledger_demonstrated) return undefined;
  return {
    evidence_gap: c.ledger_listed_only ?? [],
    items: (c.ledger_demonstrated ?? []).map((skill) => ({
      skill_canonical: skill,
      display_name: skill,
      sources: [{ kind: 'experience' as const, ref: 'fixture', recency_year: 2025, quote: 'q' }],
      strength: 'demonstrated' as const,
      most_recent_year: 2025,
    })),
  };
}

async function main(): Promise<void> {
  const file = path.join(process.cwd(), 'data', 'golden-corpus-v1.json');
  const { _bands: bands, cases } = JSON.parse(fs.readFileSync(file, 'utf-8')) as GoldenCorpus;

  const taxonomy = new SkillTaxonomyService();
  await taxonomy.onModuleInit();
  const normalizer = new SkillNormalizerService(taxonomy);
  const rubrics = new RoleRubricService();
  await rubrics.onModuleInit();
  const diffSvc = new SkillDiffService(normalizer, rubrics);

  console.log(`\nGolden-corpus eval — ${cases.length} cases (offline, 0 LLM calls)\n`);

  const scoreById = new Map<string, number>();
  const misses: string[] = [];
  const hits = {
    band: 0,
    bandTotal: 0,
    fit: 0,
    fitTotal: 0,
    gap: 0,
    gapTotal: 0,
    action: 0,
    actionTotal: 0,
    unnorm: 0,
    unnormTotal: 0,
  };

  for (const c of cases) {
    const res = diffSvc.diff({
      cv_skills_raw: c.cv_skills as RawCvSkill[],
      ...(c.target_role ? { target_role: c.target_role } : {}),
      ...(c.target_band ? { target_band: c.target_band } : {}),
      ...(c.jd_requirements ? { jd_requirements_raw: c.jd_requirements } : {}),
    });
    scoreById.set(c.id, res.overall_score);

    // buildGapItems / buildTailorChecklist read only these fields off the parsed-match shape.
    const match = {
      matched_skills: res.matched_skills,
      partial_skills: res.partial_skills,
      missing_skills: res.missing_skills,
      source_of_requirements: res.requirements_source,
      target_role: c.target_role,
      keyword_frequency: c.keyword_frequency ?? [],
    } as unknown as CvJdMatchParsedResponse;

    const gapItems = buildGapItems({
      match,
      ledger: buildFixtureLedger(c),
      marketDemand: c.market_demand ? new Map(Object.entries(c.market_demand)) : null,
      interviewSignals: c.interview_signals
        ? new Map(
            Object.entries(c.interview_signals).map(([canon, risk]) => [
              canon,
              { risk, ref: 'gold' },
            ]),
          )
        : null,
    });

    const fit = classifyFit({
      score: res.overall_score,
      required_coverage: res.required_coverage,
      seniority_verdict: 'unknown',
      unmet_deal_breakers: [],
      unverified_deal_breakers: [],
    });

    const severityByCanonical = new Map(
      gapItems
        .filter((g): g is typeof g & { canonical_name: string } => g.canonical_name !== null)
        .map((g) => [g.canonical_name, g.severity]),
    );
    const actions = buildTailorChecklist(match, buildFixtureLedger(c) ?? null, 'vi', severityByCanonical);

    const unnormalizedJd = res.unnormalized_jd_requirements.map((u) => u.raw_input);
    const unnormalizedCv = res.unnormalized_cv_skills.map((u) => u.raw_input);
    const topGap = gapItems[0]?.canonical_name ?? null;
    const topAction = actions[0]?.action_type ?? null;

    if (c.expected.match_band) {
      hits.bandTotal++;
      const [lo, hi] = bands[c.expected.match_band];
      if (res.overall_score >= lo && res.overall_score <= hi) hits.band++;
      else {
        misses.push(
          `  ${c.id}: band expected ${c.expected.match_band}[${lo}-${hi}] got ${res.overall_score}`,
        );
      }
    }
    if (c.expected.fit_verdict) {
      hits.fitTotal++;
      if (fit.verdict === c.expected.fit_verdict) hits.fit++;
      else {
        misses.push(
          `  ${c.id}: fit expected ${c.expected.fit_verdict} got ${fit.verdict} (score=${res.overall_score} cov=${res.required_coverage})`,
        );
      }
    }
    // null semantics: top_gap null = "no REAL gap" — every produced item must sit at severity 0.
    if (c.expected.top_gap_canonical === null) {
      hits.gapTotal++;
      if (gapItems.every((g) => g.severity === 0)) hits.gap++;
      else {
        misses.push(
          `  ${c.id}: expected NO gaps, got top=${gapItems[0]?.canonical_name}@${gapItems[0]?.severity}`,
        );
      }
    }
    if (c.expected.top_gap_canonical) {
      hits.gapTotal++;
      if (topGap === c.expected.top_gap_canonical) hits.gap++;
      else misses.push(`  ${c.id}: top_gap expected ${c.expected.top_gap_canonical} got ${topGap}`);
    }
    // null semantics: top_action null = the tailor checklist must be EMPTY.
    if (c.expected.top_action_type === null) {
      hits.actionTotal++;
      if (actions.length === 0) hits.action++;
      else misses.push(`  ${c.id}: expected NO actions, got ${actions[0]?.action_type}`);
    }
    if (c.expected.top_action_type) {
      hits.actionTotal++;
      if (topAction === c.expected.top_action_type) hits.action++;
      else {
        misses.push(
          `  ${c.id}: top_action expected ${c.expected.top_action_type} got ${topAction}`,
        );
      }
    }
    if (c.expected.unnormalized_jd_count != null) {
      hits.unnormTotal++;
      if (unnormalizedJd.length === c.expected.unnormalized_jd_count) hits.unnorm++;
      else {
        misses.push(
          `  ${c.id}: unnormalized_jd expected ${c.expected.unnormalized_jd_count} got ${unnormalizedJd.length}`,
        );
      }
    }
    if (c.expected.unnormalized_cv_count != null) {
      hits.unnormTotal++;
      if (unnormalizedCv.length === c.expected.unnormalized_cv_count) hits.unnorm++;
      else {
        misses.push(
          `  ${c.id}: unnormalized_cv expected ${c.expected.unnormalized_cv_count} got ${unnormalizedCv.length}`,
        );
      }
    }
    // Data sanity: outside deliberate edge_taxonomy cases, every input must normalize —
    // an unnormalized skill means the measurement is corrupt, not that the engine is wrong.
    if (
      !(c.tags ?? []).includes('edge_taxonomy') &&
      (unnormalizedCv.length > 0 || unnormalizedJd.length > 0)
    ) {
      misses.push(
        `  ${c.id}: DATA ERROR unnormalized cv=[${unnormalizedCv.join(', ')}] jd=[${unnormalizedJd.join(', ')}]`,
      );
    }

    console.log(
      `${c.id.padEnd(38)} score=${String(res.overall_score).padStart(3)} fit=${fit.verdict.padEnd(15)} top_gap=${topGap ?? '—'} top_action=${topAction ?? '—'}`,
    );
  }

  // Cross-case relations: "case_a.score OP case_b.score" (OP ∈ > >= < <= ==).
  let relOk = 0;
  let relTotal = 0;
  for (const c of cases) {
    for (const rel of c.expected.relations ?? []) {
      relTotal++;
      const m = rel.match(/^(\S+)\.score\s*(>=|<=|==|>|<)\s*(\S+)\.score$/);
      if (!m) {
        misses.push(`  ${c.id}: bad relation "${rel}"`);
        continue;
      }
      const [, a, op, b] = m;
      const va = scoreById.get(a);
      const vb = scoreById.get(b);
      if (va == null || vb == null) {
        misses.push(`  ${c.id}: relation "${rel}" refs unknown case`);
        continue;
      }
      const ok =
        op === '>'
          ? va > vb
          : op === '>='
            ? va >= vb
            : op === '<'
              ? va < vb
              : op === '=='
                ? va === vb
                : va <= vb;
      if (ok) relOk++;
      else misses.push(`  relation FAIL: ${rel} (${va} vs ${vb})`);
    }
  }

  console.log('\n=== Summary ===');
  console.log(`  match_band  : ${hits.band}/${hits.bandTotal}`);
  console.log(`  fit_verdict : ${hits.fit}/${hits.fitTotal}`);
  console.log(`  top_gap     : ${hits.gap}/${hits.gapTotal}`);
  console.log(`  top_action  : ${hits.action}/${hits.actionTotal}`);
  console.log(`  unnormalized: ${hits.unnorm}/${hits.unnormTotal}`);
  console.log(`  relations   : ${relOk}/${relTotal}`);
  if (misses.length) console.log(`\nExpectation misses:\n${misses.join('\n')}`);

  const total =
    hits.bandTotal + hits.fitTotal + hits.gapTotal + hits.actionTotal + hits.unnormTotal + relTotal;
  const pass = hits.band + hits.fit + hits.gap + hits.action + hits.unnorm + relOk;
  const fail = misses.length > 0;
  console.log(`\nVerdict: ${fail ? 'FAIL ❌' : 'PASS ✅'} (${pass}/${total} checks)\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('\neval-golden failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});

/**
 * Wave ACTION (A4) — the coherence gate: proves action ranking is stable and nothing contradicts
 * anything. Fully OFFLINE (no LLM, no DB): cv_skills + jd_requirements flow through the REAL
 * SkillNormalizer → SkillDiffService (real score/coverage), a fixture ledger/jd_dimensions/cv_seniority
 * overlay lands on top, then buildGapItems → buildTailorChecklist(+severityByCanonical, A2) →
 * decorateWithPatch → merge expected_impact (simulateActionImpact, Wave IMPACT I1/I2) produce
 * recommended_actions, buildGapReportCore produces the A1 fit verdict, and buildUnifiedPlan produces
 * the roadmap input set — the SAME call graph gap-report.service.ts and
 * cv-matches.service.ts#generateRoadmapFromMatch use (verified by reading both). Mirrors eval-gap /
 * eval-patch.
 *
 *   pnpm eval:action
 *
 * Gates (binding, task-A4-brief.md + task-I2-brief.md):
 *   1. Stability      — same input built twice → gap_items + recommended_actions byte-identical.
 *   2. Alignment      — recommended_actions[0] is the highest-severity gap among gaps with
 *                        fixability !== 'not_fixable_now' that actually produced an action (post-A2
 *                        this holds BY CONSTRUCTION — this gate PINS it against regression).
 *   3. Fit boundary   — the A1 policy-table boundary cases run the REAL path (skill-diff →
 *                        buildGapReportCore → classifyFit) → exact verdict + reasons, incl.
 *                        DEAL_BREAKER_UNVERIFIED and MID_SCORE.
 *   4. No-contradiction:
 *        (a) every action's skill_canonical ∈ gap_items canonicals.
 *        (b) no not_fixable_now gap yields an add_evidence/deepen_wording (rewrite) action.
 *        (c) a not_recommended verdict always carries a grounded reason code (no orphan verdict).
 *        (d) the top learn-class gap's requirement_id appears in buildUnifiedPlan's learn_items —
 *            valid here because roadmap generation derives learn_items FROM gap_items (see
 *            cv-matches.service.ts#generateRoadmapFromMatch → buildUnifiedPlan({ gapItems:
 *            report.gap_items }) at unified-plan.ts's gapTrack()); it does not re-derive gaps
 *            independently, so this gate has real teeth (see task-A4-report.md discovery notes).
 *   5. Impact sign        — every expected_impact has 0 <= score_min <= score_max (task-I2-brief.md).
 *   6. Impact honest-zero — add_evidence/emphasize actions always carry score {0, 0}, and
 *                           severity_drop > 0 whenever the joined gap_item's evidence_risk is
 *                           droppable (i.e. not already 'none').
 *   7. Impact monotonic   — within a case, a missing_required action on a higher-weight REQUIRED
 *                           skill (match.missing_skills[].weight) never scores score_max BELOW a
 *                           lower-weight sibling.
 *   8. Recompute-mirror   — recomputeOverall(match) (the impact simulator's diff() mirror) equals
 *                           the REAL SkillDiffService.diff() overall_score, for every case (not just
 *                           impact-simulator.spec.ts's dedicated pure-function fixtures).
 *
 * data/eval-action-cases.json case shape: see ActionCase below (mirrors GapCase in eval-gap.ts,
 * plus expect_fit for the classifyFit boundary gate).
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
import { buildGapItems, GapItem } from '../modules/gap-engine/gap-item';
import { buildTailorChecklist } from '../modules/cv-jd-match/tailor-checklist';
import { decorateWithPatch, PatchedTailorAction } from '../modules/cv-jd-match/cv-patch';
import { buildGapReportCore } from '../modules/gap-report/gap-report';
import { buildUnifiedPlan } from '../modules/gap-report/unified-plan';
import { simulateActionImpact, recomputeOverall } from '../modules/gap-report/impact-simulator';
import { normalizeJdDimensions, RawJdDimension } from '../modules/gap-engine/jd-dimensions';
import { CvSeniority, Confidence, SeniorityBucket } from '../common/services/seniority';
import { FitReasonCode } from '../modules/gap-engine/fit-strategy';

interface ActionCase {
  id: string;
  target_role: string;
  cv_skills: Array<{ name: string; proficiency_hint: string }>;
  jd_requirements?: Array<{ name: string; importance_hint?: string; required_level_hint?: string }>;
  ledger_listed_only?: string[];
  ledger_demonstrated?: string[];
  jd_dimensions?: RawJdDimension[];
  cv_seniority?: { bucket: string; est_years?: number | null; confidence: string };
  /** Per-canonical GapItem sanity checks (mirrors eval-gap's `expect`). */
  expect?: Array<{ canonical: string; cv_status?: string; fixability?: string }>;
  /** Required order (highest severity first) in the emitted recommended_actions[]. Absent when the
   *  case produces no actions (e.g. a fully-matched CV). */
  expect_actions_order?: string[];
  /** Exact classifyFit() output for the A1 policy-boundary gate. */
  expect_fit?: { verdict: string; reasons: string[] };
  /** Why the case exists / how expected values were derived (hand-authored from the documented
   *  formula unless flagged "sanity-pinned"). Not read for assertions — documentation only. */
  note?: string;
}

/** A fixture ledger from the case (mirrors eval-gap's buildFixtureLedger). */
function buildFixtureLedger(c: ActionCase): EvidenceLedger | null {
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
        sources: [
          {
            kind: 'experience' as const,
            ref: 'fixture',
            recency_year: 2025,
            quote: `Used ${s} extensively in a production project`,
          },
        ],
        strength: 'demonstrated' as const,
        most_recent_year: 2025,
      })),
    ],
  };
}

const COURSE_ADDRESSABLE_TYPES: ReadonlySet<GapItem['type']> = new Set([
  'hard_skill',
  'soft_skill',
  'language',
]);
/** classifyFit()'s ONLY not_recommended triggers (fit-strategy.ts) — the grounded reason set for
 *  no-contradiction gate (c): a not_recommended verdict MUST carry at least one of these. */
const GROUNDED_NOT_RECOMMENDED_REASONS: ReadonlySet<FitReasonCode> = new Set([
  'DEAL_BREAKER_UNMET',
  'LOW_SCORE',
  'SENIORITY_OVERQUALIFIED',
  'SEVERE_STRETCH',
]);

interface Built {
  gapItems: GapItem[];
  actions: PatchedTailorAction[];
  fit: { verdict: string; reasons: string[] };
  learnRequirementIds: Set<string>;
}

async function main(): Promise<void> {
  const file = path.join(process.cwd(), 'data', 'eval-action-cases.json');
  const { cases } = JSON.parse(fs.readFileSync(file, 'utf-8')) as { cases: ActionCase[] };

  const taxonomy = new SkillTaxonomyService();
  await taxonomy.onModuleInit();
  const normalizer = new SkillNormalizerService(taxonomy);
  const rubrics = new RoleRubricService();
  await rubrics.onModuleInit();
  const diffSvc = new SkillDiffService(normalizer, rubrics);

  console.log(`\nAction/fit coherence eval — ${cases.length} cases (offline, 0 LLM calls)\n`);

  const dataErrors: string[] = [];
  const misses: string[] = [];

  /** One full pass through the REAL pipeline gap-report.service.ts wires (gapItems → severity-ranked
   *  checklist → patch decoration) + the REAL fit + roadmap-input calls. Re-invoked verbatim for the
   *  stability gate — no memoization anywhere, so a second call is a true independent rebuild. */
  function build(c: ActionCase, res: DiffResult, match: CvJdMatchParsedResponse): Built {
    const jdDimensions = c.jd_dimensions ? normalizeJdDimensions(c.jd_dimensions) : null;
    const cvSeniority: CvSeniority | null = c.cv_seniority
      ? {
          bucket: c.cv_seniority.bucket as SeniorityBucket,
          est_years: c.cv_seniority.est_years ?? null,
          confidence: c.cv_seniority.confidence as Confidence,
          signals: [],
        }
      : null;
    const ledger = buildFixtureLedger(c);

    const gapItems = buildGapItems({ match, ledger, jdDimensions, cvSeniority });
    const severityByCanonical = new Map(gapItems.map((g) => [g.canonical_name, g.severity]));
    const checklist = buildTailorChecklist(match, ledger, 'vi', severityByCanonical);
    const patched = decorateWithPatch({ actions: checklist, gapItems, document: null, lang: 'vi' });

    // I2 (Wave IMPACT): merge deterministic what-if impact onto each action AFTER decorateWithPatch —
    // the SAME join gap-report.service.ts performs (gapByCanonical + missing/partial canonical sets
    // from the persisted match arrays) — an unjoined action gets NO expected_impact, never a
    // fabricated 0-0.
    const gapByCanonical = new Map(gapItems.map((g) => [g.canonical_name, g]));
    const missingCanonicals = new Set(match.missing_skills.map((m) => m.canonical_name));
    const partialCanonicals = new Set(match.partial_skills.map((p) => p.canonical_name));
    const actions: PatchedTailorAction[] = patched.map((a) => {
      const gi = gapByCanonical.get(a.skill_canonical);
      if (!gi) return a;
      const joined =
        a.action_type === 'missing_required'
          ? missingCanonicals.has(a.skill_canonical)
          : a.action_type === 'deepen_wording'
            ? partialCanonicals.has(a.skill_canonical)
            : true; // add_evidence/emphasize only need the gap_item — score is always 0-0
      if (!joined) return a;
      return { ...a, expected_impact: simulateActionImpact(match, gi, a) };
    });

    // Real fit path (A1): buildGapReportCore is the SAME pure function gap-report.service.ts calls.
    const core = buildGapReportCore(match, ledger, cvSeniority, null, 'vi');
    const fit = core.fit ?? { verdict: 'stretch', reasons: [] };

    // Real roadmap-input path: cv-matches.service.ts#generateRoadmapFromMatch calls this exact
    // function with interviewItems: [] for the match-only roadmap.
    const plan = buildUnifiedPlan({
      matchId: 'eval',
      sessionId: null,
      gapItems,
      interviewItems: [],
    });
    const learnRequirementIds = new Set(
      plan.learn_items.map((i) => i.requirement_id).filter((id): id is string => id !== undefined),
    );

    return { gapItems, actions, fit, learnRequirementIds };
  }

  for (const c of cases) {
    const res: DiffResult = diffSvc.diff({
      cv_skills_raw: c.cv_skills as RawCvSkill[],
      target_role: c.target_role,
      ...(c.jd_requirements ? { jd_requirements_raw: c.jd_requirements } : {}),
    });
    if (res.unnormalized_cv_skills.length > 0 || res.unnormalized_jd_requirements.length > 0) {
      dataErrors.push(
        `  ${c.id}: unnormalized [${[
          ...res.unnormalized_cv_skills.map((u) => u.raw_input),
          ...res.unnormalized_jd_requirements.map((u) => u.raw_input),
        ].join(', ')}]`,
      );
      continue;
    }

    const match = {
      matched_skills: res.matched_skills,
      partial_skills: res.partial_skills,
      missing_skills: res.missing_skills,
      keyword_frequency: [],
      source_of_requirements: res.requirements_source,
      target_role: c.target_role,
      overall_score: res.overall_score,
      required_coverage: res.required_coverage,
      ...(c.jd_dimensions ? { jd_dimensions: normalizeJdDimensions(c.jd_dimensions) } : {}),
    } as unknown as CvJdMatchParsedResponse;

    // Gate 8 — RECOMPUTE-MIRROR: the impact simulator's diff() mirror must reproduce the REAL
    // SkillDiffService.diff() overall_score for every case (not just impact-simulator.spec.ts's
    // hand-picked fixtures) — this is what lets simulateActionImpact skip re-running diff() safely.
    const mirroredBaseline = recomputeOverall(match);
    if (mirroredBaseline !== res.overall_score) {
      misses.push(
        `  ${c.id}: RECOMPUTE-MIRROR — recomputeOverall(match) = ${mirroredBaseline}, expected diff().overall_score = ${res.overall_score}`,
      );
    }

    const first = build(c, res, match);
    // Gate 1 — STABILITY: same input, independently rebuilt, must be byte-identical.
    const second = build(c, res, match);
    if (JSON.stringify(first.gapItems) !== JSON.stringify(second.gapItems)) {
      misses.push(`  ${c.id}: STABILITY — gap_items differ across two runs of the same input`);
    }
    if (JSON.stringify(first.actions) !== JSON.stringify(second.actions)) {
      misses.push(
        `  ${c.id}: STABILITY — recommended_actions differ across two runs of the same input`,
      );
    }

    const { gapItems, actions, fit, learnRequirementIds } = first;
    const byCanonical = new Map(gapItems.map((g) => [g.canonical_name, g]));
    const lines: string[] = [];

    // Per-canonical GapItem sanity (mirrors eval-gap).
    for (const e of c.expect ?? []) {
      const g = byCanonical.get(e.canonical);
      if (!g) {
        misses.push(`  ${c.id}: expected gap "${e.canonical}" not produced`);
        continue;
      }
      if (e.cv_status !== undefined && e.cv_status !== g.cv_status) {
        misses.push(
          `  ${c.id}: ${e.canonical}.cv_status = "${g.cv_status}", expected "${e.cv_status}"`,
        );
      }
      if (e.fixability !== undefined && e.fixability !== g.fixability) {
        misses.push(
          `  ${c.id}: ${e.canonical}.fixability = "${g.fixability}", expected "${e.fixability}"`,
        );
      }
      lines.push(`${e.canonical}=${g.cv_status}/${g.fixability}`);
    }

    // Gate 2 — ALIGNMENT: recommended_actions[0] must be the highest-severity gap among gaps whose
    // fixability !== not_fixable_now AND that actually produced an action (some fixable gaps may not
    // survive the checklist's per-bucket candidacy rules — e.g. only bucketed skill types).
    const actionCanonicals = new Set(actions.map((a) => a.skill_canonical));
    const alignable = gapItems.filter(
      (g) => g.fixability !== 'not_fixable_now' && actionCanonicals.has(g.canonical_name),
    );
    if (actions.length > 0 && alignable.length > 0) {
      const top = alignable.reduce((a, b) => (b.severity > a.severity ? b : a));
      if (actions[0].skill_canonical !== top.canonical_name) {
        misses.push(
          `  ${c.id}: ALIGNMENT — recommended_actions[0] = "${actions[0].skill_canonical}", expected highest-severity fixable gap "${top.canonical_name}" (severity ${top.severity})`,
        );
      }
    }
    if (c.expect_actions_order) {
      const got = actions.map((a) => a.skill_canonical);
      if (JSON.stringify(got) !== JSON.stringify(c.expect_actions_order)) {
        misses.push(
          `  ${c.id}: actions order = [${got.join(', ')}], expected [${c.expect_actions_order.join(', ')}]`,
        );
      }
      lines.push(`actions[${got.join(' > ')}]`);
    }

    // Gate 3 — FIT BOUNDARY: exact verdict + reasons through the REAL classifyFit path.
    if (c.expect_fit) {
      if (fit.verdict !== c.expect_fit.verdict) {
        misses.push(
          `  ${c.id}: fit.verdict = "${fit.verdict}", expected "${c.expect_fit.verdict}"`,
        );
      }
      if (JSON.stringify(fit.reasons) !== JSON.stringify(c.expect_fit.reasons)) {
        misses.push(
          `  ${c.id}: fit.reasons = [${fit.reasons.join(', ')}], expected [${c.expect_fit.reasons.join(', ')}]`,
        );
      }
      lines.push(`fit[${fit.verdict}:${fit.reasons.join('+')}]`);
    }

    // Gate 4(a) — every action's canonical must be a real gap_item (no orphan action referencing a
    // canonical outside the same requirement set — e.g. a future market-implied action bypassing gaps).
    for (const a of actions) {
      if (!byCanonical.has(a.skill_canonical)) {
        misses.push(
          `  ${c.id}: NO-CONTRADICTION(a) — action "${a.skill_canonical}" has no matching gap_item`,
        );
      }
    }

    // Gate 4(b) — a not_fixable_now gap (already matched/proven — nothing to fix) must never yield an
    // add_evidence or deepen_wording (rewrite) action.
    for (const a of actions) {
      if (
        (a.action_type === 'add_evidence' || a.action_type === 'deepen_wording') &&
        a.fixability === 'not_fixable_now'
      ) {
        misses.push(
          `  ${c.id}: NO-CONTRADICTION(b) — "${a.skill_canonical}" is not_fixable_now but yielded a ${a.action_type} action`,
        );
      }
    }

    // Gate 4(c) — a not_recommended verdict must always carry a reason grounded in the classifyFit
    // not_recommended trigger set (no orphan verdict with only positive/neutral reason codes).
    if (fit.verdict === 'not_recommended') {
      const grounded = fit.reasons.some((r) =>
        GROUNDED_NOT_RECOMMENDED_REASONS.has(r as FitReasonCode),
      );
      if (!grounded) {
        misses.push(
          `  ${c.id}: NO-CONTRADICTION(c) — not_recommended verdict has no grounded reason (reasons: [${fit.reasons.join(', ')}])`,
        );
      }
    }

    // Gate 4(d) — roadmap discovery (task-A4-brief.md Step 2): generateRoadmapFromMatch derives
    // learn_items FROM gap_items (buildUnifiedPlan), so the top-severity learn-class gap must appear
    // in the roadmap's input set (identified by requirement_id — stable across the same call).
    const learnGaps = gapItems.filter(
      (g) => g.fixability === 'learn' && COURSE_ADDRESSABLE_TYPES.has(g.type),
    );
    if (learnGaps.length > 0) {
      const topLearn = learnGaps.reduce((a, b) => (b.severity > a.severity ? b : a));
      if (!learnRequirementIds.has(topLearn.requirement_id)) {
        misses.push(
          `  ${c.id}: NO-CONTRADICTION(d) — top learn-class gap "${topLearn.canonical_name}" missing from roadmap learn_items input set`,
        );
      }
    }

    // Gate 5 — IMPACT SIGN: every expected_impact carries 0 <= score_min <= score_max.
    for (const a of actions) {
      if (!a.expected_impact) continue;
      const { score_min, score_max } = a.expected_impact;
      if (!(score_min >= 0 && score_max >= score_min)) {
        misses.push(
          `  ${c.id}: IMPACT-SIGN — "${a.skill_canonical}" expected_impact = {score_min:${score_min}, score_max:${score_max}}, expected 0 <= score_min <= score_max`,
        );
      }
    }

    // Gate 6 — IMPACT HONEST-ZERO: add_evidence/emphasize never move the score (0-0 by
    // construction — they don't change cv_level); their real payoff is severity_drop, which must be
    // > 0 whenever the joined gap_item's evidence_risk still has headroom to drop (not already
    // 'none').
    for (const a of actions) {
      if (!a.expected_impact) continue;
      if (a.action_type !== 'add_evidence' && a.action_type !== 'emphasize') continue;
      const { score_min, score_max, severity_drop } = a.expected_impact;
      if (score_min !== 0 || score_max !== 0) {
        misses.push(
          `  ${c.id}: IMPACT-HONEST-ZERO — "${a.skill_canonical}" (${a.action_type}) expected_impact score = {${score_min}, ${score_max}}, expected {0, 0}`,
        );
      }
      const gi = byCanonical.get(a.skill_canonical);
      if (gi && gi.evidence_risk !== 'none' && !(severity_drop !== null && severity_drop > 0)) {
        misses.push(
          `  ${c.id}: IMPACT-HONEST-ZERO — "${a.skill_canonical}" (${a.action_type}) evidence_risk="${gi.evidence_risk}" is droppable but severity_drop = ${severity_drop}, expected > 0`,
        );
      }
    }

    // Gate 7 — IMPACT MONOTONIC: within this case, a missing_required action on a higher-weight
    // REQUIRED skill (match.missing_skills[].weight) must never score_max BELOW a lower-weight
    // sibling — effective_weight = weight × importance_multiplier is monotone in weight when the
    // multiplier (REQUIRED, always 1.0 for this bucket) is held equal.
    const weightByCanonical = new Map(
      match.missing_skills.map((m) => [m.canonical_name, m.weight]),
    );
    const missingRequiredWithImpact = actions
      .filter((a) => a.action_type === 'missing_required' && a.expected_impact)
      .map((a) => ({ a, weight: weightByCanonical.get(a.skill_canonical) ?? 0 }))
      .sort((x, y) => y.weight - x.weight);
    for (let i = 1; i < missingRequiredWithImpact.length; i++) {
      const prev = missingRequiredWithImpact[i - 1];
      const cur = missingRequiredWithImpact[i];
      if (
        prev.weight > cur.weight &&
        cur.a.expected_impact!.score_max > prev.a.expected_impact!.score_max
      ) {
        misses.push(
          `  ${c.id}: IMPACT-MONOTONIC — "${cur.a.skill_canonical}" (weight ${cur.weight}) score_max ${cur.a.expected_impact!.score_max} exceeds higher-weight "${prev.a.skill_canonical}" (weight ${prev.weight}) score_max ${prev.a.expected_impact!.score_max}`,
        );
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
  console.error('\neval-action failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});

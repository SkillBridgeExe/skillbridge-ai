import { decorateWithPatch } from '../../../src/modules/cv-jd-match/cv-patch';
import { buildTailorChecklist } from '../../../src/modules/cv-jd-match/tailor-checklist';
import { buildGapItems } from '../../../src/modules/gap-engine/gap-item';
import {
  MatchedSkill,
  MissingSkill,
  PartialSkill,
} from '../../../src/modules/cv-jd-match/skill-diff.service';
import {
  CvJdMatchParsedResponse,
  KeywordFrequency,
} from '../../../src/modules/cv-jd-match/dto/cv-jd-match-response.dto';
import { EvidenceLedger } from '../../../src/common/services/evidence-ledger';
import { CanonicalCvDocument } from '../../../src/common/types/canonical-cv';

/**
 * PR4 — CV Patch Engine. decorateWithPatch is a PURE deterministic overlay that joins gap_items onto
 * the tailor checklist. Asserts the honesty core (a `before` only for an evidence-backed rewrite),
 * the contradiction guard (a decorated action's fixability matches its action_type), anchor_confidence
 * gating (no guessed bullet), stable ids, and strict 1:1 order/count preservation.
 */
const matched = (c: string, w: number, cv = 4, req = 3): MatchedSkill => ({
  skill_id: c,
  canonical_name: c,
  display_name: c.toUpperCase(),
  cv_level: cv,
  required_level: req,
  importance: 'REQUIRED',
  weight: w,
  skill_type: 'hard',
});
const partial = (c: string, w: number, cv: number, req: number): PartialSkill => ({
  ...matched(c, w, cv, req),
  gap_levels: req - cv,
});
const missing = (c: string, w: number): MissingSkill => ({
  skill_id: c,
  canonical_name: c,
  display_name: c.toUpperCase(),
  required_level: 3,
  importance: 'REQUIRED',
  weight: w,
  skill_type: 'hard',
  gap_levels: 3,
});
const kf = (c: string, cv_count: number, jd_count: number): KeywordFrequency => ({
  canonical_name: c,
  display_name: c.toUpperCase(),
  cv_count,
  jd_count,
});
const baseMatch = (over: Partial<CvJdMatchParsedResponse>): CvJdMatchParsedResponse =>
  ({
    overall_score: 50,
    match_ratio: 50,
    required_coverage: 0.5,
    matched_skills: [],
    partial_skills: [],
    missing_skills: [],
    bonus_skills: [],
    unnormalized_cv_skills: [],
    unnormalized_jd_requirements: [],
    scoring_breakdown: {
      total_requirements: 0,
      matched_count: 0,
      partial_count: 0,
      missing_count: 0,
      weight_sum: 0,
      achieved_weight: 0,
      required_total: 0,
      required_met: 0,
      raw_weighted_score: 0,
      cap_applied: false,
    },
    source_of_requirements: 'jd_extraction',
    target_role: null,
    ...over,
  }) as CvJdMatchParsedResponse;
const ledgerOf = (gap: string[], demonstrated: Array<[string, string]>): EvidenceLedger => ({
  evidence_gap: gap,
  items: [
    ...gap.map((c) => ({
      skill_canonical: c,
      display_name: c.toUpperCase(),
      sources: [{ kind: 'skills_list' as const, ref: 'Skills', recency_year: null }],
      strength: 'listed_only' as const,
      most_recent_year: null,
    })),
    ...demonstrated.map(([c, ref]) => ({
      skill_canonical: c,
      display_name: c.toUpperCase(),
      sources: [{ kind: 'project' as const, ref, recency_year: null }],
      strength: 'demonstrated' as const,
      most_recent_year: null,
    })),
  ],
});
const docWithProject = (name: string, bullets: string[]): CanonicalCvDocument => ({
  language: 'vi',
  contact: { name: null, email: null, phone: null, location: null, links: [] },
  summary: '',
  education: [],
  experience: [],
  projects: [{ name, role: null, tech: [], bullets, link: null }],
  skills: { technical: [], soft: [], languages: [], tools: [] },
  certifications: [],
  activities: [],
});

const run = (
  match: CvJdMatchParsedResponse,
  ledger: EvidenceLedger | null,
  document: CanonicalCvDocument | null,
) =>
  decorateWithPatch({
    actions: buildTailorChecklist(match, ledger, 'vi'),
    gapItems: buildGapItems({ match, ledger }),
    document,
    lang: 'vi',
  });

const DEMO_REF = 'Dự án — Booking App';

describe('decorateWithPatch (PR4, pure patch plan)', () => {
  const sqlPartial = baseMatch({ partial_skills: [partial('sql', 0.2, 2, 4)] });
  const sqlLedger = ledgerOf([], [['sql', DEMO_REF]]);

  it('rewrite + locatable bullet → before = the EXACT bullet, anchor_confidence high, section + stable ids', () => {
    const doc = docWithProject(DEMO_REF, [
      'Xây luồng đặt phòng dùng SQL tối ưu truy vấn',
      'Viết tài liệu',
    ]);
    const [item] = run(sqlPartial, sqlLedger, doc);
    expect(item.action_type).toBe('deepen_wording');
    expect(item.fixability).toBe('rewrite');
    expect(item.anchor_confidence).toBe('high');
    expect(item.before).toBe('Xây luồng đặt phòng dùng SQL tối ưu truy vấn');
    expect(item.cv_section).toContain('Dự án');
    expect(item.action_id).toBe('deepen_wording:sql');
    expect(item.requirement_id).toBeTruthy();
    expect(item.rewrite_eligible).toBe(true);
  });

  it('rewrite but no bullet mentions the skill → anchor_confidence low, NO before (never guesses)', () => {
    const doc = docWithProject(DEMO_REF, ['Làm việc nhóm 4 người', 'Viết tài liệu']); // no SQL token
    const [item] = run(sqlPartial, sqlLedger, doc);
    expect(item.anchor_confidence).toBe('low');
    expect(item.before).toBeNull();
    expect(item.cv_section).toContain('Dự án'); // section is real (from ledger); only the bullet is uncertain
  });

  it('no document → no before, anchor_confidence null (advise-only degrade)', () => {
    const [item] = run(sqlPartial, sqlLedger, null);
    expect(item.before).toBeNull();
    expect(item.anchor_confidence).toBeNull();
  });

  it('does NOT substring-false-positive (java ⊄ javascript)', () => {
    const m = baseMatch({ partial_skills: [partial('java', 0.2, 2, 4)] });
    const led = ledgerOf([], [['java', DEMO_REF]]);
    const doc = docWithProject(DEMO_REF, ['Built a frontend in JavaScript and TypeScript']);
    const [item] = run(m, led, doc);
    expect(item.before).toBeNull(); // "java" must not match inside "JavaScript"
    expect(item.anchor_confidence).toBe('low');
  });

  it('missing_required + add_evidence → never a before, never rewrite_eligible, fixability echoed', () => {
    const m = baseMatch({
      missing_skills: [missing('docker', 0.3)],
      matched_skills: [matched('react', 0.2)],
    });
    const out = run(m, ledgerOf(['react'], []), null);
    const miss = out.find((x) => x.action_type === 'missing_required')!;
    expect(miss.before).toBeNull();
    expect(miss.rewrite_eligible).toBe(false);
    expect(miss.fixability).toBe('learn');
    const add = out.find((x) => x.action_type === 'add_evidence')!;
    expect(add.before).toBeNull();
    expect(add.rewrite_eligible).toBe(false);
    expect(add.fixability).toBe('add_evidence');
  });

  it('emphasize → no before, gets a deterministic insertion_hint (surface, not reword)', () => {
    const m = baseMatch({
      matched_skills: [matched('docker', 0.1)],
      keyword_frequency: [kf('docker', 1, 3)],
    });
    const [item] = run(m, null, null);
    expect(item.action_type).toBe('emphasize');
    expect(item.before).toBeNull();
    expect(item.insertion_hint).toBeTruthy();
    expect(item.rewrite_eligible).toBe(true);
  });

  it('contradiction guard + honesty core + strict 1:1 order/count preservation', () => {
    const m = baseMatch({
      partial_skills: [partial('sql', 0.2, 2, 4)],
      missing_skills: [missing('docker', 0.3)],
      matched_skills: [matched('react', 0.2)],
      keyword_frequency: [kf('react', 0, 3)],
    });
    const ledger = ledgerOf(['react'], [['sql', DEMO_REF]]);
    const actions = buildTailorChecklist(m, ledger, 'vi');
    const out = run(m, ledger, docWithProject(DEMO_REF, ['Dùng SQL tối ưu truy vấn 30%']));

    // 1:1: decorator never adds/drops/reorders — same action sequence.
    expect(out).toHaveLength(actions.length);
    expect(out.map((x) => x.action_id)).toEqual(
      actions.map((a) => `${a.action_type}:${a.skill_canonical}`),
    );
    // Contradiction guard: a decorated action's joined fixability matches its action_type class.
    for (const x of out) {
      if (x.action_type === 'deepen_wording') expect(x.fixability).toBe('rewrite');
      if (x.action_type === 'missing_required') expect(x.fixability).toBe('learn');
      if (x.action_type === 'add_evidence') expect(x.fixability).toBe('add_evidence');
    }
    // Honesty core: a `before` can ONLY appear on an evidence-backed rewrite.
    for (const x of out) {
      if (x.before !== null) {
        expect(x.action_type).toBe('deepen_wording');
        expect(x.fixability).toBe('rewrite');
        expect(x.anchor_confidence).toBe('high');
      }
    }
  });
});

/**
 * PARITY GATE (2026-07-21) — the paste path and the job-rec card must agree on the
 * same JD + same CV facts. Pins the prod incident where one JD scored 100/100 pasted
 * vs 45% on its card (silent requirement drop + default-level collision), and proves
 * the parity helpers close the gap. Real taxonomy, real scanner, real diff — no DB, no LLM.
 */
import { RoleRubricService } from '../../common/services/role-rubric.service';
import { SkillNormalizerService } from '../../common/services/skill-normalizer.service';
import { SkillTaxonomyService } from '../../common/services/skill-taxonomy.service';
import { SkillTextScannerService } from '../../common/services/skill-text-scanner.service';
import { toRawCvSkills, type ReviewSkills } from './cv-review-facts';
import { reconcileCvProficiency, unionJdRequirements } from './match-input-parity';
import { RawCvSkill, RawJdRequirement, SkillDiffService } from './skill-diff.service';

const JD_TEXT = `
Tuyển PHP Developer (Fresher/Junior).
Yêu cầu:
- Thành thạo PHP, HTML, CSS, JavaScript.
- Có kinh nghiệm với Laravel và MySQL.
- Biết dùng Git; từng làm với ReactJS là lợi thế.
- English proficiency: đọc hiểu tài liệu.
`;

// What the LLM actually returned on prod: headline skills only, no level hints.
const LLM_JD: RawJdRequirement[] = [
  { name: 'PHP', importance_hint: 'REQUIRED' },
  { name: 'HTML', importance_hint: 'REQUIRED' },
  { name: 'CSS', importance_hint: 'REQUIRED' },
  { name: 'JavaScript', importance_hint: 'REQUIRED' },
  { name: 'English', importance_hint: 'REQUIRED' },
];

// Fresh CV extraction: same five skills, no proficiency hints (→ fail-closed NOVICE(2), #1 fix).
const LLM_CV: RawCvSkill[] = ['PHP', 'HTML', 'CSS', 'JavaScript', 'English'].map((name) => ({
  name,
}));

// The stored review graded the candidate NOVICE (level 2) on their real skills —
// including the framework/tool skills the LLM's JD extraction summarized away.
const REVIEW: ReviewSkills = [
  { name: 'PHP', proficiency_hint: 'NOVICE' },
  { name: 'HTML', proficiency_hint: 'NOVICE' },
  { name: 'CSS', proficiency_hint: 'NOVICE' },
  { name: 'JavaScript', proficiency_hint: 'NOVICE' },
  { name: 'English', proficiency_hint: 'NOVICE' },
  { name: 'Laravel', proficiency_hint: 'NOVICE' },
  { name: 'MySQL', proficiency_hint: 'NOVICE' },
  { name: 'Git', proficiency_hint: 'NOVICE' },
  { name: 'ReactJS', proficiency_hint: 'NOVICE' },
] as ReviewSkills;

describe('paste-vs-card parity on the same JD', () => {
  let diffSvc: SkillDiffService;
  let scanner: SkillTextScannerService;
  let normalize: (name: string) => string[];

  beforeAll(async () => {
    const taxonomy = new SkillTaxonomyService();
    await taxonomy.onModuleInit();
    const normalizer = new SkillNormalizerService(taxonomy);
    const rubrics = new RoleRubricService();
    await rubrics.onModuleInit();
    diffSvc = new SkillDiffService(normalizer, rubrics);
    scanner = new SkillTextScannerService(taxonomy);
    scanner.buildMatchers();
    normalize = (name) =>
      normalizer
        .normalizeMention(name)
        .map((r) => r.canonical_name)
        .filter((c): c is string => c !== null);
  });

  /** The card path: gazetteer requirements (all REQUIRED, no level → default 3),
   *  CV facts from the stored review (R1). Mirrors JobRecommendationService inputs. */
  function cardScore() {
    const scanReqs: RawJdRequirement[] = scanner.scan(JD_TEXT).map((s) => ({
      name: s.canonical_name,
      importance_hint: 'REQUIRED',
      evidence_text: s.matched_text,
    }));
    return diffSvc.diff({
      cv_skills_raw: toRawCvSkills(REVIEW, []),
      jd_requirements_raw: scanReqs,
    });
  }

  it('scanner sees more of the JD than the LLM headline extraction did', () => {
    const canonicals = scanner.scan(JD_TEXT).map((s) => s.canonical_name);
    expect(canonicals).toEqual(expect.arrayContaining(['laravel', 'mysql', 'git', 'react']));
    expect(canonicals.length).toBeGreaterThan(LLM_JD.length);
  });

  it('the fail-closed default (#1 fix) closes the split at the root: bare CV skills no longer inflate', () => {
    const paste = diffSvc.diff({ cv_skills_raw: LLM_CV, jd_requirements_raw: LLM_JD });
    const card = cardScore();
    // Pre-fix this split 100 (paste: default 3 vs 3, full match) vs 45 (card: NOVICE partials).
    // With the fail-closed default a bare CV skill is NOVICE(2) — a PARTIAL on the default-3
    // requirement — so the fresh-extraction paste path lands at the SAME capped 45 as the card,
    // WITHOUT needing the parity layer. (bug hunt 2026-07-22, #1)
    expect(paste.overall_score).toBe(45);
    expect(card.overall_score).toBe(45);
  });

  it('WITH parity both paths land on the same score for the same facts', () => {
    const jdReqs = unionJdRequirements(LLM_JD, scanner.scan(JD_TEXT), normalize);
    const cvSkills = reconcileCvProficiency(LLM_CV, REVIEW, normalize);
    const paste = diffSvc.diff({ cv_skills_raw: cvSkills, jd_requirements_raw: jdReqs });
    const card = cardScore();

    // Requirement basis: paste scores a superset of what the card scores.
    const pasteCanonicals = new Set(
      [...paste.matched_skills, ...paste.partial_skills, ...paste.missing_skills].map(
        (s) => s.canonical_name,
      ),
    );
    for (const req of [...card.matched_skills, ...card.partial_skills, ...card.missing_skills]) {
      expect(pasteCanonicals.has(req.canonical_name)).toBe(true);
    }

    expect(paste.overall_score).not.toBeNull();
    expect(card.overall_score).not.toBeNull();
    expect(Math.abs(paste.overall_score! - card.overall_score!)).toBeLessThanOrEqual(3);
  });
});

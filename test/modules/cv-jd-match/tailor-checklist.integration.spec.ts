/**
 * END-TO-END (deterministic) integration test for the Tailor-to-JD pipeline.
 *
 * REAL taxonomy (151 skills) · REAL role rubrics · REAL SkillDiffService scoring ·
 * REAL SkillTextScanner keyword counts · REAL evidence ledger over a CanonicalCvDocument.
 * NO mocks, NO LLM — in prod the LLM only does extraction; the extracted arrays are the
 * fixture here, so EVERYTHING downstream of extraction runs exactly as in production:
 *
 *   extraction (given) → normalize → diff (JD-first, type-weighted) → keyword_frequency
 *   → evidence ledger → buildTailorChecklist
 *
 * The scenario is a realistic VN fresher-frontend CV against a realistic VN JD, crafted so
 * every checklist rule fires from REAL computed data (not synthetic counts).
 */
import { SkillTaxonomyService } from '../../../src/common/services/skill-taxonomy.service';
import { SkillNormalizerService } from '../../../src/common/services/skill-normalizer.service';
import { RoleRubricService } from '../../../src/common/services/role-rubric.service';
import { SkillTextScannerService } from '../../../src/common/services/skill-text-scanner.service';
import { SkillDiffService } from '../../../src/modules/cv-jd-match/skill-diff.service';
import { buildKeywordFrequency } from '../../../src/modules/cv-jd-match/cv-jd-match.service';
import { buildEvidenceLedger } from '../../../src/common/services/evidence-ledger';
import { buildTailorChecklist } from '../../../src/modules/cv-jd-match/tailor-checklist';
import { CanonicalCvDocument, emptyCanonicalCv } from '../../../src/common/types/canonical-cv';
import { CvJdMatchParsedResponse } from '../../../src/modules/cv-jd-match/dto/cv-jd-match-response.dto';

describe('Tailor-to-JD — real-pipeline integration (no mocks, no LLM)', () => {
  let diffSvc: SkillDiffService;
  let scanner: SkillTextScannerService;
  let normalizer: SkillNormalizerService;

  beforeAll(async () => {
    const taxonomy = new SkillTaxonomyService();
    await taxonomy.onModuleInit();
    normalizer = new SkillNormalizerService(taxonomy);
    const rubrics = new RoleRubricService();
    await rubrics.onModuleInit();
    diffSvc = new SkillDiffService(normalizer, rubrics);
    scanner = new SkillTextScannerService(taxonomy);
    scanner.onModuleInit();
  });

  // ── The CV as a structured document (what cv-parse produces) ─────────────────
  const cvDoc: CanonicalCvDocument = {
    ...emptyCanonicalCv('vi'),
    summary: 'Sinh viên năm cuối Kỹ thuật phần mềm, định hướng Frontend, đang tự học TypeScript.',
    experience: [
      {
        org: 'FPT Software',
        role: 'Thực tập sinh Frontend',
        start: '06/2025',
        end: 'Present',
        location: 'Hà Nội',
        bullets: [
          'Xây dựng giao diện quản trị nội bộ với ReactJS',
          'Tối ưu hiệu năng render cho danh sách 10000 dòng',
        ],
      },
    ],
    projects: [
      {
        name: 'Web bán hàng EcomViet',
        role: 'Team of 3',
        tech: ['ReactJS', 'Redux'],
        bullets: ['Phát triển giỏ hàng và luồng thanh toán với ReactJS'],
        link: null,
      },
    ],
    skills: {
      technical: ['ReactJS', 'JavaScript', 'Docker', 'SQL'],
      soft: [],
      languages: [],
      tools: [],
    },
  };

  // The same CV as plain text (what keyword counting sees).
  const cvText = [
    cvDoc.summary,
    'FPT Software — Thực tập sinh Frontend',
    ...cvDoc.experience[0].bullets,
    'Web bán hàng EcomViet (ReactJS, Redux)',
    ...cvDoc.projects[0].bullets,
    'Kỹ năng: ReactJS, JavaScript, Docker, SQL',
  ].join('\n');

  // A realistic VN JD: ReactJS stressed 3×, TypeScript 2×, HTML/CSS required, Docker a plus.
  const jdText = [
    'Tuyển Frontend Developer (ReactJS)',
    'Mô tả: Phát triển sản phẩm web với ReactJS và TypeScript.',
    'Yêu cầu:',
    '- Thành thạo ReactJS (bắt buộc)',
    '- Sử dụng tốt TypeScript trong dự án thực tế (bắt buộc)',
    '- Nắm vững HTML, CSS (bắt buộc)',
    '- Biết Docker là lợi thế',
  ].join('\n');

  // What the LLM extraction step yields in prod (deterministic fixture by design).
  const cv_skills_raw = [
    { name: 'ReactJS', proficiency_hint: 'INTERMEDIATE' }, // JD wants ADVANCED → partial
    { name: 'TypeScript', proficiency_hint: 'INTERMEDIATE' }, // matched
    { name: 'Docker', proficiency_hint: 'INTERMEDIATE' }, // matched (PREFERRED)
    { name: 'SQL', proficiency_hint: 'INTERMEDIATE' }, // bonus — JD never asks
  ];
  const jd_requirements_raw = [
    { name: 'ReactJS', importance_hint: 'REQUIRED', required_level_hint: 'ADVANCED' },
    { name: 'TypeScript', importance_hint: 'REQUIRED', required_level_hint: 'INTERMEDIATE' },
    { name: 'HTML', importance_hint: 'REQUIRED', required_level_hint: 'INTERMEDIATE' },
    { name: 'CSS', importance_hint: 'REQUIRED', required_level_hint: 'INTERMEDIATE' },
    { name: 'Docker', importance_hint: 'PREFERRED', required_level_hint: 'INTERMEDIATE' },
  ];

  it('produces an honest, anchored, numerically-grounded checklist end-to-end', () => {
    // 1. REAL deterministic diff (JD-first precedence, type-weighted, capped scoring).
    const diff = diffSvc.diff({
      cv_skills_raw,
      jd_requirements_raw,
      target_role: 'frontend_developer',
    });
    expect(diff.requirements_source).toBe('jd_extraction'); // the JD wins over the rubric
    expect(diff.partial_skills.map((s) => s.canonical_name)).toContain('react'); // 3 < 4
    expect(diff.missing_skills.map((s) => s.canonical_name)).toEqual(
      expect.arrayContaining(['html', 'css']),
    );

    // 2. REAL keyword counts from the actual texts.
    const keyword_frequency = buildKeywordFrequency(
      [...diff.matched_skills, ...diff.partial_skills, ...diff.missing_skills],
      scanner.scan(cvText),
      scanner.scan(jdText),
    );

    // 3. REAL evidence ledger over the structured document.
    const ledger = buildEvidenceLedger(
      cvDoc,
      (t) => scanner.scan(t),
      (c) => normalizer.getByCanonical(c)?.display_name ?? c,
      2026,
    );
    expect(ledger.items.find((i) => i.skill_canonical === 'react')?.strength).toBe('demonstrated');
    expect(ledger.evidence_gap).toContain('docker'); // listed in Skills, never shown in a bullet

    // 4. Assemble the parsed response exactly the way cv-jd-match.service does.
    const parsed: CvJdMatchParsedResponse = {
      overall_score: diff.overall_score,
      match_ratio: diff.match_ratio,
      required_coverage: diff.required_coverage,
      matched_skills: diff.matched_skills,
      partial_skills: diff.partial_skills,
      missing_skills: diff.missing_skills,
      bonus_skills: diff.bonus_skills,
      keyword_frequency,
      unnormalized_cv_skills: diff.unnormalized_cv_skills,
      unnormalized_jd_requirements: diff.unnormalized_jd_requirements,
      scoring_breakdown: diff.scoring_breakdown,
      inferred_skills: diff.inferred_skills,
      source_of_requirements: diff.requirements_source,
      target_role: 'frontend_developer',
    };

    // 5. The checklist under test.
    const checklist = buildTailorChecklist(parsed, ledger, 'vi');
    // Human-readable evidence for the review (kept intentionally).
    console.log('TAILOR CHECKLIST (real pipeline):\n' + JSON.stringify(checklist, null, 2));

    const ofType = (t: string) => checklist.filter((a) => a.action_type === t);

    // Rule 1 — HTML/CSS are REQUIRED and absent → honest missing_required (no fabrication).
    const missing = ofType('missing_required');
    expect(missing.map((a) => a.skill_canonical).sort()).toEqual(['css', 'html']);
    for (const a of missing) {
      expect(a.why).toContain('thực sự có'); // conditional — never "just add it"
      expect(a.rewrite_eligible).toBe(false);
    }

    // Rule 2 — Docker matched but listed-only → add a proving bullet (not a reword).
    expect(ofType('add_evidence').map((a) => a.skill_canonical)).toEqual(['docker']);
    expect(ofType('add_evidence')[0].rewrite_eligible).toBe(false);

    // Rule 3 — TypeScript: the JD stresses it (2×), the CV mentions it once → emphasize,
    // with the REAL counts surfacing in the copy.
    const emph = ofType('emphasize');
    expect(emph.map((a) => a.skill_canonical)).toEqual(['typescript']);
    expect(emph[0].jd_count).toBeGreaterThanOrEqual(2);
    expect(emph[0].cv_count).toBeLessThanOrEqual(1);
    expect(emph[0].why).toContain(String(emph[0].jd_count));
    expect(emph[0].rewrite_eligible).toBe(true);

    // Rule 4 — ReactJS: partial (3/5 vs 4/5) WITH demonstrated evidence → deepen the wording,
    // anchored to the real CV location that proves it.
    const deep = ofType('deepen_wording');
    expect(deep.map((a) => a.skill_canonical)).toEqual(['react']);
    expect(deep[0].cv_level).toBe(3);
    expect(deep[0].required_level).toBe(4);
    expect(deep[0].anchor?.ref).toContain('FPT Software');
    expect(deep[0].rewrite_eligible).toBe(true);

    // Global invariants: one action per skill; SQL (bonus, JD never asked) gets NO action.
    const canonicals = checklist.map((a) => a.skill_canonical);
    expect(new Set(canonicals).size).toBe(canonicals.length);
    expect(canonicals).not.toContain('sql');
  });
});

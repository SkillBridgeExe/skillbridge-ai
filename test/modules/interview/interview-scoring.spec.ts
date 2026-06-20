import {
  ROLE_RUBRIC_WEIGHTS,
  resolveRoleFamily,
  topicDimensions,
  band,
  aggregateInterviewScore,
  Dimension,
  RoleFamily,
  AnswerScore,
} from '../../../src/modules/interview/interview-scoring';

const DIMS: Dimension[] = [
  'technical_depth',
  'problem_solving',
  'communication',
  'evidence_credibility',
  'role_fit',
];

describe('ROLE_RUBRIC_WEIGHTS', () => {
  it('has all 6 role-families, each summing to exactly 100 over the 5 dimensions', () => {
    const families: RoleFamily[] = [
      'ic_eng',
      'data_ai_ml',
      'devops_sre',
      'qa',
      'lead_manager',
      'fresher_intern',
    ];
    for (const f of families) {
      const row = ROLE_RUBRIC_WEIGHTS[f];
      expect(Object.keys(row).sort()).toEqual([...DIMS].sort());
      expect(DIMS.reduce((s, d) => s + row[d], 0)).toBe(100);
    }
  });

  it('encodes the approved emphases (IC=tech-heavy, manager=comms-heavy, fresher=low-evidence)', () => {
    expect(ROLE_RUBRIC_WEIGHTS.ic_eng.technical_depth).toBe(40);
    expect(ROLE_RUBRIC_WEIGHTS.lead_manager.communication).toBe(30);
    expect(ROLE_RUBRIC_WEIGHTS.fresher_intern.evidence_credibility).toBe(5);
  });
});

describe('resolveRoleFamily', () => {
  it('fresher/intern seniority overrides role → fresher_intern (low evidence weight)', () => {
    expect(resolveRoleFamily('frontend_developer', 'fresher')).toBe('fresher_intern');
    expect(resolveRoleFamily('backend_developer', 'intern')).toBe('fresher_intern');
  });

  it('maps role-family by keyword for non-fresher seniority', () => {
    expect(resolveRoleFamily('frontend_developer', 'mid')).toBe('ic_eng');
    expect(resolveRoleFamily('ai_ml_engineer', 'senior')).toBe('data_ai_ml');
    expect(resolveRoleFamily('devops_engineer', 'senior')).toBe('devops_sre');
    expect(resolveRoleFamily('qa_tester', 'mid')).toBe('qa');
    expect(resolveRoleFamily('engineering_manager', 'senior')).toBe('lead_manager');
  });

  it('defaults an unknown role to ic_eng', () => {
    expect(resolveRoleFamily('something_weird', 'mid')).toBe('ic_eng');
  });
});

describe('topicDimensions (topic→dimension map, spec §4)', () => {
  it('maps probe phases to tech+evidence, scenario to problem_solving, behavioral to comms+role_fit', () => {
    expect(topicDimensions('SKILL_PROBE')).toEqual(['technical_depth', 'evidence_credibility']);
    expect(topicDimensions('JD_REQUIREMENT')).toEqual(['technical_depth', 'evidence_credibility']);
    expect(topicDimensions('SCENARIO')).toEqual(['problem_solving']);
    expect(topicDimensions('BEHAVIORAL')).toEqual(['communication', 'role_fit']);
  });

  it('excludes SCREENING + WRAP from scoring (warm-up / close)', () => {
    expect(topicDimensions('SCREENING')).toEqual([]);
    expect(topicDimensions('WRAP')).toEqual([]);
  });
});

describe('band (BARS, spec §3)', () => {
  it('bands by the anchored tiers', () => {
    expect(band(30)).toBe('poor');
    expect(band(40)).toBe('poor');
    expect(band(55)).toBe('borderline');
    expect(band(61)).toBe('solid');
    expect(band(80)).toBe('solid');
    expect(band(95)).toBe('outstanding');
  });
});

describe('aggregateInterviewScore', () => {
  const ans = (over: Partial<AnswerScore>): AnswerScore => ({
    topic_phase: 'SKILL_PROBE',
    score: 70,
    depth_signal: 'adequate',
    ...over,
  });

  it('ignores SCREENING/WRAP answers (warm-up never scored)', () => {
    const out = aggregateInterviewScore({
      answers: [ans({ topic_phase: 'SCREENING', score: 10 }), ans({ score: 80 })],
      role: 'frontend_developer',
      seniority: 'mid',
    });
    expect(out.scored_answers).toBe(1);
    const tech = out.dimensions.find((d) => d.dimension === 'technical_depth');
    expect(tech?.score).toBe(80);
  });

  it('an answer contributes to ALL of its phase dimensions (behavioral → comms + role_fit)', () => {
    const out = aggregateInterviewScore({
      answers: [ans({ topic_phase: 'BEHAVIORAL', score: 60, depth_signal: 'deep' })],
      role: 'frontend_developer',
      seniority: 'mid',
    });
    expect(out.dimensions.map((d) => d.dimension).sort()).toEqual(['communication', 'role_fit']);
  });

  it('dimension score is depth-weighted (a deep 80 outweighs a shallow 40)', () => {
    const out = aggregateInterviewScore({
      answers: [
        ans({ score: 80, depth_signal: 'deep' }),
        ans({ score: 40, depth_signal: 'shallow' }),
      ],
      role: 'frontend_developer',
      seniority: 'mid',
    });
    const tech = out.dimensions.find((d) => d.dimension === 'technical_depth')!;
    // (80*1.0 + 40*0.5) / 1.5 = 66.67 → 67, not the plain mean 60
    expect(tech.score).toBe(67);
  });

  it('overall is the role-weighted mean over ONLY the dimensions that have answers (renormalized)', () => {
    const out = aggregateInterviewScore({
      answers: [ans({ score: 80, depth_signal: 'deep' })],
      role: 'frontend_developer',
      seniority: 'mid',
    });
    expect(out.overall).toBe(80);
    expect(out.overall_band).toBe('solid');
    expect(out.role_family).toBe('ic_eng');
  });

  it('weights differ by role family: a manager weights communication far higher than an IC', () => {
    const answers: AnswerScore[] = [
      ans({ topic_phase: 'SKILL_PROBE', score: 40, depth_signal: 'deep' }),
      ans({ topic_phase: 'BEHAVIORAL', score: 90, depth_signal: 'deep' }),
    ];
    const ic = aggregateInterviewScore({ answers, role: 'backend_developer', seniority: 'senior' });
    const mgr = aggregateInterviewScore({
      answers,
      role: 'engineering_manager',
      seniority: 'senior',
    });
    expect(mgr.overall).toBeGreaterThan(ic.overall);
  });

  it('honest empty: no scorable answers → overall 0, no dimensions, scored_answers 0', () => {
    const out = aggregateInterviewScore({
      answers: [ans({ topic_phase: 'WRAP', score: 50 })],
      role: 'frontend_developer',
      seniority: 'mid',
    });
    expect(out).toMatchObject({ overall: 0, scored_answers: 0 });
    expect(out.dimensions).toEqual([]);
  });
});

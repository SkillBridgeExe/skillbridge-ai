import { buildFacts, groundInsight } from '../../../src/modules/jobs/trends/trends-insight.logic';
import { SkillTrendsResponse } from '../../../src/modules/jobs/trends/skill-demand.service';
import { TrendsInsightFacts } from '../../../src/modules/jobs/trends/trends-insight.types';

const TRENDS: SkillTrendsResponse = {
  role_code: 'backend_developer',
  period: '2026-06-07',
  total_active_jobs: 200,
  sample_size: 200,
  data_confidence: 'high',
  skills: [
    {
      canonical_name: 'security',
      display_name: 'Security',
      posting_count: 78,
      pct_of_postings: 39.3,
      salary_p50_vnd: 28000000,
      trend_delta: 2,
    },
    {
      canonical_name: 'python',
      display_name: 'Python',
      posting_count: 54,
      pct_of_postings: 27.0,
      salary_p50_vnd: 25000000,
      trend_delta: 0,
    },
  ],
};

describe('buildFacts', () => {
  it('role-level (no CV): covered is null on every skill', () => {
    const f = buildFacts(TRENDS, null);
    expect(f.personalized).toBe(false);
    expect(f.role_code).toBe('backend_developer');
    expect(f.total_active_jobs).toBe(200);
    expect(f.skills.map((s) => s.covered)).toEqual([null, null]);
    expect(f.skills[0]).toMatchObject({ skill: 'security', pct_of_postings: 39.3, trend_delta: 2 });
  });

  it('personalized: covered reflects the CV skill set', () => {
    const f = buildFacts(TRENDS, new Set(['python']));
    expect(f.personalized).toBe(true);
    expect(f.skills.find((s) => s.skill === 'security')!.covered).toBe(false);
    expect(f.skills.find((s) => s.skill === 'python')!.covered).toBe(true);
  });
});

const FACTS: TrendsInsightFacts = {
  role_code: 'backend_developer',
  period: '2026-06-07',
  total_active_jobs: 200,
  sample_size: 200,
  data_confidence: 'high',
  personalized: true,
  co_occurrence: [],
  skills: [
    {
      skill: 'security',
      display_name: 'Security',
      pct_of_postings: 39.3,
      trend_delta: 2,
      salary_p50_vnd: 28000000,
      covered: false,
    },
    {
      skill: 'python',
      display_name: 'Python',
      pct_of_postings: 27.0,
      trend_delta: 0,
      salary_p50_vnd: 25000000,
      covered: true,
    },
  ],
};

describe('groundInsight (anti-hallucination guard)', () => {
  it('drops skills not in FACTS and re-attaches REAL numbers (ignores LLM numbers)', () => {
    const llm = {
      summary: 'Security đang hot.',
      insights: [
        { skill: 'security', comment: 'ưu tiên cao' },
        { skill: 'kubernetes_fake', comment: 'invented' },
        { skill: 'python', comment: 'ổn' },
      ],
      recommended_skills: ['security', 'python', 'kubernetes_fake'],
    };
    const out = groundInsight(llm, FACTS);
    expect(out.insights.map((i) => i.skill)).toEqual(['security', 'python']);
    expect(out.insights[0].pct_of_postings).toBe(39.3);
    expect(out.insights[0].comment).toBe('ưu tiên cao');
    expect(out.recommended_skills.map((r) => r.skill)).toEqual(['security']);
    expect(out.summary).toBe('Security đang hot.');
    expect(out.cached).toBe(false);
  });

  it('parse failure / non-object → deterministic fallback (top facts, no comments)', () => {
    const out = groundInsight('not json', FACTS);
    expect(out.insights.length).toBeGreaterThan(0);
    expect(out.insights.every((i) => i.comment === '')).toBe(true);
    expect(out.summary).toContain('Security');
  });
});

describe('insight sâu v1 — co-occurrence FACTS + skill_pairs guard', () => {
  const PAIRS = [
    {
      a: 'docker',
      a_display: 'Docker',
      b: 'kubernetes',
      b_display: 'Kubernetes',
      pair_count: 31,
      pct_of_postings: 24.8,
    },
    {
      a: 'react',
      a_display: 'React',
      b: 'typescript',
      b_display: 'TypeScript',
      pair_count: 22,
      pct_of_postings: 17.6,
    },
  ];

  it('buildFacts carries co_occurrence pairs verbatim (empty by default)', () => {
    const none = buildFacts(TRENDS, null);
    expect(none.co_occurrence).toEqual([]);
    const f = buildFacts(TRENDS, null, PAIRS);
    expect(f.co_occurrence).toEqual(PAIRS);
  });

  it('groundInsight keeps ONLY pairs that exist in FACTS and re-attaches their numbers', () => {
    const facts = buildFacts(TRENDS, null, PAIRS);
    const out = groundInsight(
      {
        summary: 'ok',
        insights: [],
        recommended_skills: [],
        skill_pairs: [
          { a: 'docker', b: 'kubernetes', comment: 'Docker thường đi với K8s.', pair_count: 999 },
          { a: 'php', b: 'wordpress', comment: 'bịa — phải bị loại' },
          { a: 'kubernetes', b: 'docker', comment: 'đảo chiều vẫn là pair thật' },
        ],
      },
      facts,
    );
    expect(out.skill_pairs.length).toBe(1); // dedup kể cả đảo chiều, pair bịa bị loại
    expect(out.skill_pairs[0]).toMatchObject({
      a: 'docker',
      b: 'kubernetes',
      pair_count: 31, // số LLM (999) bị vứt — RE-ATTACH từ FACTS
      pct_of_postings: 24.8,
    });
    expect(out.skill_pairs[0].comment).toContain('K8s');
  });

  it('fallback (no LLM) returns empty skill_pairs, not undefined', () => {
    const facts = buildFacts(TRENDS, null, PAIRS);
    const out = groundInsight('not json', facts);
    expect(out.skill_pairs).toEqual([]);
  });
});

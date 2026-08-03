import {
  JobRecommendation,
  JobRecommendationService,
  buildJobRecommendation,
  normalizeLocationCityCodes,
  projectJobRecommendationSnapshot,
  sortJobRecommendations,
} from '../../../src/modules/jobs/reco/job-recommendation.service';

function recommendation(id: string, over: Partial<JobRecommendation> = {}): JobRecommendation {
  return {
    job_id: id,
    slug: id,
    application_mode: 'NATIVE',
    saved: false,
    title: id,
    company_name: 'SkillBridge',
    location: null,
    city_codes: [],
    role_code: 'backend_developer',
    experience_level: 'JUNIOR',
    work_mode: null,
    employment_type: null,
    salary_min: null,
    salary_max: null,
    salary_visible: false,
    salary_period: null,
    currency: 'VND',
    source_url: null,
    posted_at: null,
    match_score: 50,
    recommendation_score: 50,
    severe_stretch: false,
    seniority_factor: 1,
    level_gap: 0,
    semantic_similarity: null,
    rank: 1,
    matched_skills: [],
    partial_skills: [],
    missing_skills: [],
    scoring_breakdown: {} as never,
    experience_fit: {
      cv_seniority: 'junior',
      job_level: 'JUNIOR',
      verdict: 'fits',
      confidence: 'high',
    },
    ...over,
  };
}

describe('Job Explorer deterministic sorting', () => {
  it('keeps recommendation rank as the default order', () => {
    const rows = [
      recommendation('rank-2', { rank: 2, match_score: 99 }),
      recommendation('rank-1', { rank: 1, match_score: 40 }),
    ];

    expect(sortJobRecommendations(rows, 'RECOMMENDED').map((row) => row.job_id)).toEqual([
      'rank-1',
      'rank-2',
    ]);
  });

  it('sorts skill score descending with recommendation rank as a stable tie-breaker', () => {
    const rows = [
      recommendation('lower', { rank: 1, match_score: 40 }),
      recommendation('tie-2', { rank: 2, match_score: 90 }),
      recommendation('tie-1', { rank: 1, match_score: 90 }),
    ];

    expect(sortJobRecommendations(rows, 'SKILL_MATCH').map((row) => row.job_id)).toEqual([
      'tie-1',
      'tie-2',
      'lower',
    ]);
  });

  it('sorts newest first and leaves unknown dates last', () => {
    const rows = [
      recommendation('unknown', { posted_at: null }),
      recommendation('older', { posted_at: '2026-01-01T00:00:00.000Z' }),
      recommendation('newer', { posted_at: '2026-07-01T00:00:00.000Z' }),
    ];

    expect(sortJobRecommendations(rows, 'NEWEST').map((row) => row.job_id)).toEqual([
      'newer',
      'older',
      'unknown',
    ]);
  });

  it('sorts visible salary descending and never leaks hidden salary into ordering', () => {
    const rows = [
      recommendation('hidden', {
        salary_visible: false,
        salary_max: 999_000_000,
      }),
      recommendation('lower', {
        salary_visible: true,
        salary_max: 20_000_000,
        salary_period: 'MONTH',
      }),
      recommendation('higher', {
        salary_visible: true,
        salary_max: 40_000_000,
        salary_period: 'MONTH',
      }),
    ];

    expect(sortJobRecommendations(rows, 'SALARY_DESC').map((row) => row.job_id)).toEqual([
      'higher',
      'lower',
      'hidden',
    ]);
  });

  it('falls back to recommendation rank when salary currencies or periods are incomparable', () => {
    const rows = [
      recommendation('rank-2-vnd', {
        rank: 2,
        salary_visible: true,
        salary_max: 40_000_000,
        salary_period: 'MONTH',
        currency: 'VND',
      }),
      recommendation('rank-1-usd', {
        rank: 1,
        salary_visible: true,
        salary_max: 2_000,
        salary_period: 'MONTH',
        currency: 'USD',
      }),
    ];

    expect(sortJobRecommendations(rows, 'SALARY_DESC').map((row) => row.job_id)).toEqual([
      'rank-1-usd',
      'rank-2-vnd',
    ]);
  });
});

describe('Job Explorer location normalization', () => {
  it.each([
    ['Ho Chi Minh City', ['HCM']],
    ['TP.HCM', ['HCM']],
    ['Hà Nội', ['HAN']],
    ['Đà Nẵng', ['DAD']],
    ['Bình Dương', ['BDU']],
  ])('derives a stable city facet from legacy location text: %s', (location, expected) => {
    expect(normalizeLocationCityCodes(location)).toEqual(expected);
  });

  it('uses structured city codes first and falls back to location text when they are absent', () => {
    const mapped = buildJobRecommendation(
      {
        id: 'legacy-location',
        slug: 'legacy-location',
        application_mode: 'NATIVE',
        saved: false,
        title: 'Backend Developer',
        company_name: 'SkillBridge',
        location: 'Ho Chi Minh City',
        primary_city_code: null,
        location_city_codes: [],
        role_code: 'backend_developer',
        experience_level: 'JUNIOR',
        work_mode: 'ONSITE',
        employment_type: 'FULL_TIME',
        salary_min: null,
        salary_max: null,
        salary_visible: false,
        salary_period: null,
        currency: 'VND',
        source_url: null,
        posted_at: null,
        skills: [],
      },
      {
        overall_score: 50,
        matched_skills: [],
        partial_skills: [],
        missing_skills: [],
        required_coverage: 0.5,
        scoring_breakdown: {},
      } as never,
      1,
      null,
      {
        cv_seniority: 'junior',
        job_level: 'JUNIOR',
        verdict: 'fits',
        confidence: 'high',
      },
    );

    expect(mapped.city_codes).toEqual(['HCM']);
  });
});

describe('Job Explorer role scope, metadata filters, and facets', () => {
  const baseCandidate = {
    slug: 'job',
    application_mode: 'NATIVE' as const,
    saved: false,
    company_name: 'SkillBridge',
    location: 'Ho Chi Minh City',
    primary_city_code: 'HCM',
    location_city_codes: ['HCM'],
    experience_level: 'JUNIOR',
    work_mode: 'HYBRID' as const,
    employment_type: 'FULL_TIME' as const,
    salary_min: '20000000',
    salary_max: '30000000',
    salary_visible: true,
    currency: 'VND',
    source_url: null,
    posted_at: '2026-07-01T00:00:00.000Z',
    skills: [],
  };

  function serviceWith(cvTargetRole: string | null, candidates: unknown[]) {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ id: 'cv-1', parsed_json: null, target_role: cvTargetRole }])
      .mockResolvedValueOnce([]) // no skills: enough to exercise scope/filter/facet without LLM
      .mockResolvedValueOnce(candidates)
      .mockResolvedValueOnce([]) // latest review proficiency
      .mockResolvedValueOnce([]); // latest interview signals
    const service = new JobRecommendationService(
      { query } as never,
      { get: jest.fn() } as never,
      { embed: jest.fn() } as never,
      { diff: jest.fn() } as never,
      { getByCanonical: jest.fn() } as never,
      {
        find: jest.fn().mockResolvedValue({
          cv_target_role: cvTargetRole,
          recommendations: (
            candidates as Array<
              typeof baseCandidate & { id: string; title: string; role_code: string | null }
            >
          ).map((candidate, index) =>
            recommendation(candidate.id, {
              rank: index + 1,
              title: candidate.title,
              company_name: candidate.company_name,
              location: candidate.location,
              city_codes: candidate.location_city_codes,
              role_code: candidate.role_code,
              experience_level: candidate.experience_level,
              work_mode: candidate.work_mode,
              employment_type: candidate.employment_type,
              salary_min: Number(candidate.salary_min),
              salary_max: Number(candidate.salary_max),
              salary_visible: candidate.salary_visible,
              currency: candidate.currency,
              posted_at: candidate.posted_at,
            }),
          ),
        }),
        tryClaim: jest.fn(),
        waitFor: jest.fn(),
        releaseClaim: jest.fn(),
        save: jest.fn(),
      } as never,
    );
    return { service, query };
  }

  it('defaults to the CV target role and reports honest pool/facet/data-quality metadata', async () => {
    const candidates = [
      {
        ...baseCandidate,
        id: 'backend-hcm',
        title: 'Backend Developer',
        role_code: 'backend_developer',
      },
      {
        ...baseCandidate,
        id: 'backend-han',
        title: 'Backend Developer Hanoi',
        role_code: 'backend_developer',
        location: 'Hanoi',
        primary_city_code: 'HAN',
        location_city_codes: ['HAN'],
        work_mode: 'REMOTE',
        experience_level: null,
      },
      {
        ...baseCandidate,
        id: 'frontend-hcm',
        title: 'Frontend Developer',
        role_code: 'frontend_developer',
      },
    ];
    const { service } = serviceWith('backend_developer', candidates);

    const response = await service.recommendForCv('user-1', 'cv-1', {
      cityCodes: ['HCM'],
    });

    expect(response.role_scope).toEqual({
      role_code: 'backend_developer',
      source: 'cv_target',
    });
    expect(response.pool_size).toBe(2);
    expect(response.eligible_pool_size).toBe(1);
    expect(response.facets.city_codes).toEqual([
      { value: 'HAN', count: 1 },
      { value: 'HCM', count: 1 },
    ]);
    expect(response.data_quality.missing_experience_level).toBe(1);
    expect(response.filters_applied.city_codes).toEqual(['HCM']);
  });

  it('distinguishes explicit all-role browsing from an omitted CV-target scope', async () => {
    const candidates = [
      {
        ...baseCandidate,
        id: 'backend',
        title: 'Backend Developer',
        role_code: 'backend_developer',
      },
      {
        ...baseCandidate,
        id: 'frontend',
        title: 'Frontend Developer',
        role_code: 'frontend_developer',
      },
    ];
    const { service } = serviceWith('backend_developer', candidates);

    const response = await service.recommendForCv('user-1', 'cv-1', {
      roleCode: 'all',
    });

    expect(response.role_scope).toEqual({ role_code: null, source: 'all' });
    expect(response.pool_size).toBe(2);
  });

  it('reuses a snapshot for pagination/filtering without entering the billable generator', async () => {
    const candidates = [
      {
        ...baseCandidate,
        id: 'backend',
        title: 'Backend Developer',
        role_code: 'backend_developer',
      },
    ];
    const { service } = serviceWith('backend_developer', candidates);
    const beforeGenerate = jest.fn();

    const response = await service.recommendForCv(
      'user-1',
      'cv-1',
      { offset: 10, sort: 'NEWEST' },
      { beforeGenerate },
    );

    expect(beforeGenerate).not.toHaveBeenCalled();
    expect(response.generation.cache_hit).toBe(true);
  });

  it('overlays the current saved-job state instead of serving the cached value', async () => {
    const candidates = [
      {
        ...baseCandidate,
        id: 'backend',
        title: 'Backend Developer',
        role_code: 'backend_developer',
        saved: true,
      },
    ];
    const { service } = serviceWith('backend_developer', candidates);

    const response = await service.recommendForCv('user-1', 'cv-1');

    expect(response.recommendations[0].saved).toBe(true);
  });

  it('does not silently broaden to all roles when the CV target role has no active jobs', async () => {
    const candidates = [
      {
        ...baseCandidate,
        id: 'frontend',
        title: 'Frontend Developer',
        role_code: 'frontend_developer',
      },
    ];
    const { service } = serviceWith('backend_developer', candidates);

    const response = await service.recommendForCv('user-1', 'cv-1');

    expect(response.role_scope).toEqual({
      role_code: 'backend_developer',
      source: 'cv_target',
    });
    expect(response.pool_size).toBe(0);
    expect(response.recommendations).toEqual([]);
  });

  it('uses the independently ranked role view and returns a stable snapshot token', () => {
    const backend = recommendation('backend', {
      role_code: 'backend_developer',
      rank: 2,
    });
    const backendScoped = recommendation('backend', {
      role_code: 'backend_developer',
      rank: 1,
    });
    const frontend = recommendation('frontend', {
      role_code: 'frontend_developer',
      rank: 1,
    });

    const response = projectJobRecommendationSnapshot(
      'cv-1',
      {
        snapshot_token: '11111111-1111-4111-8111-111111111111',
        cv_target_role: 'backend_developer',
        recommendations: [frontend, backend],
        recommendation_ids_by_role: { backend_developer: [backendScoped.job_id] },
      },
      {},
      true,
    );

    expect(response.recommendations.map((row) => [row.job_id, row.rank])).toEqual([['backend', 1]]);
    expect(response.generation.snapshot_token).toBe('11111111-1111-4111-8111-111111111111');
  });
});

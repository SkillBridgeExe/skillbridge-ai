import {
  buildJobRecommendation,
  JobRecommendationService,
} from '../../../src/modules/jobs/reco/job-recommendation.service';

const USER_ID = 'user-1';
const CV_ID = 'cv-1';

const CANDIDATE_ROW = {
  id: 'job-1',
  slug: 'backend-dev',
  application_mode: 'NATIVE' as const,
  saved: false,
  title: 'Backend Developer',
  company_name: 'Acme',
  location: null,
  role_code: 'backend',
  experience_level: null,
  salary_min: null,
  salary_max: null,
  salary_visible: false,
  currency: 'VND',
  source_url: null,
  posted_at: null,
  skills: [],
};

const DIFF_STUB = {
  matched_skills: [],
  partial_skills: [],
  missing_skills: [],
  overall_score: 80,
  scoring_breakdown: {},
} as never;

function snapshotStore() {
  return {
    find: jest.fn().mockResolvedValue(null),
    tryClaim: jest.fn().mockResolvedValue('claim-1'),
    waitFor: jest.fn().mockResolvedValue(null),
    releaseClaim: jest.fn().mockResolvedValue(undefined),
    save: jest.fn().mockResolvedValue(true),
  };
}

/**
 * Plain-object mocks at the IO boundary (mirrors diagnosis-chat-platform.service.spec.ts style).
 * `db.query` is asserted to be called in the SAME order the service issues queries: cvRows →
 * cvSkillRows → candidates → (TRUST B1) latest-review skills. `llm.embed` rejects so the dense
 * signal (B) degrades gracefully and never issues a 5th query — keeps the mock minimal.
 */
function makeService(options: { reviewRows: Array<{ parsed_response: unknown }> }) {
  const query = jest
    .fn()
    .mockResolvedValueOnce([{ id: CV_ID, parsed_json: null, target_role: 'backend' }]) // cvRows
    .mockResolvedValueOnce([{ canonical_name: 'react' }]) // cvSkillRows
    .mockResolvedValueOnce([CANDIDATE_ROW]) // candidates
    .mockResolvedValueOnce(options.reviewRows) // TRUST (B1) latest-review lookup
    .mockResolvedValueOnce([]); // no interview signals

  const db = { query };
  const config = { get: jest.fn().mockReturnValue(undefined) };
  const llm = { embed: jest.fn().mockRejectedValue(new Error('no vectors in test')) };
  const diff = jest.fn().mockReturnValue(DIFF_STUB);
  const skillDiff = { diff };
  const taxonomy = { getByCanonical: jest.fn().mockReturnValue(undefined) };

  const service = new JobRecommendationService(
    db as never,
    config as never,
    llm as never,
    skillDiff as never,
    taxonomy as never,
    snapshotStore() as never,
  );
  return { service, diff, query };
}

describe('JobRecommendationService — TRUST (B1) real proficiency', () => {
  it('feeds SkillDiffService with the proficiency_hint from the latest CV review', async () => {
    const { service, diff } = makeService({
      reviewRows: [
        {
          parsed_response: {
            ats_extracted: {
              skills_extracted: [
                { name: 'React', proficiency_hint: 'beginner', evidence_text: null },
              ],
            },
          },
        },
      ],
    });

    await service.recommendForCv(USER_ID, CV_ID, {});

    expect(diff).toHaveBeenCalledWith(
      expect.objectContaining({
        cv_skills_raw: [{ name: 'React', proficiency_hint: 'beginner' }],
      }),
    );
  });

  it('honors employer min_level as required_level_hint (null min_level → no hint, engine default)', async () => {
    const row = {
      ...CANDIDATE_ROW,
      skills: [
        { canonical: 'postgresql', importance: 'REQUIRED', min_level: 5 },
        { canonical: 'git', importance: 'PREFERRED', min_level: null },
      ],
    };
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ id: CV_ID, parsed_json: null, target_role: 'backend' }])
      .mockResolvedValueOnce([{ canonical_name: 'react' }])
      .mockResolvedValueOnce([row])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const service = new JobRecommendationService(
      { query } as never,
      { get: jest.fn().mockReturnValue(undefined) } as never,
      { embed: jest.fn().mockRejectedValue(new Error('no vectors in test')) } as never,
      { diff: jest.fn().mockReturnValue(DIFF_STUB) } as never,
      { getByCanonical: jest.fn().mockReturnValue(undefined) } as never,
      snapshotStore() as never,
    );
    const diff = (service as unknown as { skillDiff: { diff: jest.Mock } }).skillDiff.diff;

    await service.recommendForCv(USER_ID, CV_ID, {});

    expect(diff).toHaveBeenCalledWith(
      expect.objectContaining({
        jd_requirements_raw: [
          { name: 'postgresql', importance_hint: 'REQUIRED', required_level_hint: 'EXPERT' },
          { name: 'git', importance_hint: 'PREFERRED', required_level_hint: undefined },
        ],
      }),
    );
  });

  it('falls back to presence-only cv_skills_raw when no review exists', async () => {
    const { service, diff } = makeService({ reviewRows: [] });

    await service.recommendForCv(USER_ID, CV_ID, {});

    expect(diff).toHaveBeenCalledWith(
      expect.objectContaining({
        cv_skills_raw: [{ name: 'react' }],
      }),
    );
  });
});

describe('JobRecommendationService — stable explorer snapshots', () => {
  const candidate = (id: string, role: string, skill: string) => ({
    ...CANDIDATE_ROW,
    id,
    slug: id,
    title: id,
    role_code: role,
    experience_level: 'JUNIOR',
    skills: [{ canonical: skill, importance: 'REQUIRED', min_level: 2 }],
  });

  it('ranks each role independently and returns the persisted snapshot token', async () => {
    const rows = [
      candidate('frontend-high', 'frontend_developer', 'react'),
      candidate('backend-mid', 'backend_developer', 'sql'),
      candidate('backend-low', 'backend_developer', 'java'),
    ];
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ id: CV_ID, parsed_json: null, target_role: 'backend_developer' }])
      .mockResolvedValueOnce([{ canonical_name: 'sql' }])
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const snapshots = snapshotStore();
    const service = new JobRecommendationService(
      { query } as never,
      { get: jest.fn().mockReturnValue(undefined) } as never,
      { embed: jest.fn().mockRejectedValue(new Error('no vectors in test')) } as never,
      {
        diff: jest.fn(({ jd_requirements_raw }) => ({
          matched_skills: [],
          partial_skills: [],
          missing_skills: [],
          scoring_breakdown: {},
          overall_score:
            jd_requirements_raw[0].name === 'react'
              ? 100
              : jd_requirements_raw[0].name === 'sql'
                ? 80
                : 60,
          required_coverage: 1,
        })),
      } as never,
      { getByCanonical: jest.fn().mockReturnValue(undefined) } as never,
      snapshots as never,
    );

    const response = await service.recommendForCv(USER_ID, CV_ID);

    expect(response.recommendations.map((row) => [row.job_id, row.rank])).toEqual([
      ['backend-mid', 1],
      ['backend-low', 2],
    ]);
    expect(response.generation.snapshot_token).toBe('claim-1');
    const persisted = snapshots.save.mock.calls[0][3];
    expect(
      persisted.recommendations.map((row: { job_id: string; rank: number }) => [
        row.job_id,
        row.rank,
      ]),
    ).toEqual([
      ['frontend-high', 1],
      ['backend-mid', 2],
      ['backend-low', 3],
    ]);
    expect(persisted.recommendation_ids_by_role.backend_developer).toEqual([
      'backend-mid',
      'backend-low',
    ]);
  });

  it('uses an ownership-scoped snapshot token without generating or consuming quota', async () => {
    const row = candidate('backend', 'backend_developer', 'sql');
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ id: CV_ID, parsed_json: null, target_role: 'backend_developer' }])
      .mockResolvedValueOnce([{ job_id: 'backend' }])
      .mockResolvedValueOnce([row]);
    const stored = {
      snapshot_token: '11111111-1111-4111-8111-111111111111',
      cv_target_role: 'backend_developer',
      recommendations: [
        buildJobRecommendation(
          row,
          {
            matched_skills: [],
            partial_skills: [],
            missing_skills: [],
            overall_score: 80,
            required_coverage: 1,
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
        ),
      ],
      recommendation_ids_by_role: { backend_developer: ['backend'] },
    };
    const snapshots = {
      ...snapshotStore(),
      findByToken: jest.fn().mockResolvedValue(stored),
    };
    const beforeGenerate = jest.fn();
    const service = new JobRecommendationService(
      { query } as never,
      { get: jest.fn() } as never,
      { embed: jest.fn() } as never,
      { diff: jest.fn() } as never,
      { getByCanonical: jest.fn() } as never,
      snapshots as never,
    );

    const response = await service.recommendForCv(
      USER_ID,
      CV_ID,
      { snapshotToken: stored.snapshot_token },
      { beforeGenerate },
    );

    expect(snapshots.findByToken).toHaveBeenCalledWith(USER_ID, CV_ID, stored.snapshot_token);
    expect(beforeGenerate).not.toHaveBeenCalled();
    expect(response.generation.snapshot_token).toBe(stored.snapshot_token);
    expect(response.recommendations[0]?.saved).toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[0][0])).toContain('FROM public.cvs');
    expect(String(query.mock.calls[1][0])).toContain('FROM public.saved_jobs');
    expect(query.mock.calls.some(([sql]) => String(sql).includes('FROM public.jobs j'))).toBe(
      false,
    );
  });
});

/**
 * R4 (RECOMMENDATION') — the user's LATEST completed interview annotates job cards whose
 * requirements it flagged (knowledge/evidence gaps). CONFIDENCE OVERLAY ONLY: it must never
 * change scores or ranking in v1 (a weak interview must not silently bury a job), and any
 * lookup failure degrades to "no overlay".
 */
describe('JobRecommendationService — R4 interview signal overlay', () => {
  const SESSION_ROW = {
    id: 'abcdef12-3456-7890-abcd-ef1234567890',
    gap_items: [
      {
        weakness_type: 'knowledge_gap',
        display_name: 'React',
        skill_canonical: 'react',
        severity: 0.8,
      },
    ],
  };

  function makeR4Service(options: { signalRows?: unknown[]; signalReject?: boolean }) {
    const row = {
      ...CANDIDATE_ROW,
      skills: [{ canonical: 'react', importance: 'REQUIRED', min_level: null }],
    };
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ id: CV_ID, parsed_json: null, target_role: 'backend' }]) // cvRows
      .mockResolvedValueOnce([{ canonical_name: 'react' }]) // cvSkillRows
      .mockResolvedValueOnce([row]) // candidates
      .mockResolvedValueOnce([]); // latest-review skills
    if (options.signalReject) query.mockRejectedValueOnce(new Error('signals query down'));
    else query.mockResolvedValueOnce(options.signalRows ?? []); // R4 latest interview session
    return new JobRecommendationService(
      { query } as never,
      { get: jest.fn().mockReturnValue(undefined) } as never,
      { embed: jest.fn().mockRejectedValue(new Error('no vectors in test')) } as never,
      { diff: jest.fn().mockReturnValue(DIFF_STUB) } as never,
      { getByCanonical: jest.fn().mockReturnValue(undefined) } as never,
      snapshotStore() as never,
    );
  }

  it('annotates a job whose requirement the latest completed interview flagged', async () => {
    const res = await makeR4Service({ signalRows: [SESSION_ROW] }).recommendForCv(
      USER_ID,
      CV_ID,
      {},
    );

    expect(res.recommendations[0].interview_signals).toEqual([
      // display_name rides along so the FE never has to render the raw canonical as a chip
      // (post-merge review finding: 'node_js' next to sibling chips saying 'Node.js').
      { skill_canonical: 'react', display_name: 'React', risk: 0.8, session_ref: 'abcdef12' },
    ]);
  });

  it('is annotation-only: scores and rank identical with and without signals; absent when none', async () => {
    const withSignals = await makeR4Service({ signalRows: [SESSION_ROW] }).recommendForCv(
      USER_ID,
      CV_ID,
      {},
    );
    const without = await makeR4Service({}).recommendForCv(USER_ID, CV_ID, {});

    expect(without.recommendations[0].interview_signals).toBeUndefined();
    const strip = (rec: (typeof withSignals)['recommendations'][number]) => {
      const { interview_signals: _signals, ...rest } = rec;
      return rest;
    };
    expect(withSignals.recommendations.map(strip)).toEqual(without.recommendations.map(strip));
  });

  it('never throws: signal lookup failure degrades to no overlay', async () => {
    const res = await makeR4Service({ signalReject: true }).recommendForCv(USER_ID, CV_ID, {});

    expect(res.recommendations).toHaveLength(1);
    expect(res.recommendations[0].interview_signals).toBeUndefined();
  });
});

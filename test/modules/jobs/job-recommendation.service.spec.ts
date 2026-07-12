import { JobRecommendationService } from '../../../src/modules/jobs/reco/job-recommendation.service';

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

/**
 * Plain-object mocks at the IO boundary (mirrors diagnosis-chat-platform.service.spec.ts style).
 * `db.query` is asserted to be called in the SAME order the service issues queries: cvRows →
 * cvSkillRows → candidates → (TRUST B1) latest-review skills. `llm.embed` rejects so the dense
 * signal (B) degrades gracefully and never issues a 5th query — keeps the mock minimal.
 */
function makeService(options: { reviewRows: Array<{ parsed_response: unknown }> }) {
  const query = jest
    .fn()
    .mockResolvedValueOnce([{ id: CV_ID, parsed_json: null }]) // cvRows
    .mockResolvedValueOnce([{ canonical_name: 'react' }]) // cvSkillRows
    .mockResolvedValueOnce([CANDIDATE_ROW]) // candidates
    .mockResolvedValueOnce(options.reviewRows); // TRUST (B1) latest-review lookup

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
      .mockResolvedValueOnce([{ id: CV_ID, parsed_json: null }])
      .mockResolvedValueOnce([{ canonical_name: 'react' }])
      .mockResolvedValueOnce([row])
      .mockResolvedValueOnce([]);
    const service = new JobRecommendationService(
      { query } as never,
      { get: jest.fn().mockReturnValue(undefined) } as never,
      { embed: jest.fn().mockRejectedValue(new Error('no vectors in test')) } as never,
      { diff: jest.fn().mockReturnValue(DIFF_STUB) } as never,
      { getByCanonical: jest.fn().mockReturnValue(undefined) } as never,
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
      .mockResolvedValueOnce([{ id: CV_ID, parsed_json: null }]) // cvRows
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
    );
  }

  it('annotates a job whose requirement the latest completed interview flagged', async () => {
    const res = await makeR4Service({ signalRows: [SESSION_ROW] }).recommendForCv(
      USER_ID,
      CV_ID,
      {},
    );

    expect(res.recommendations[0].interview_signals).toEqual([
      { skill_canonical: 'react', risk: 0.8, session_ref: 'abcdef12' },
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

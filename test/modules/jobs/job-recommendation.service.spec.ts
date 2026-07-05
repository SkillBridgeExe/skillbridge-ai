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

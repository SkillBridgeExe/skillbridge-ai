import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  JobRecommendationQueryDto,
  JobRecommendationSort,
} from '../../../src/modules/jobs/dto/job-recommendation-query.dto';
import {
  buildMetadataFacets,
  buildRecommendationDataQuality,
  CandidateJobRow,
  filterCandidateJobs,
  JobRecommendation,
  sortRecommendations,
} from '../../../src/modules/jobs/reco/job-recommendation.service';

function candidate(overrides: Partial<CandidateJobRow> = {}): CandidateJobRow {
  return {
    id: 'job-1',
    slug: 'backend',
    application_mode: 'EXTERNAL',
    saved: false,
    title: 'Backend Developer',
    company_name: 'Acme',
    location: 'Ho Chi Minh City',
    primary_city_code: 'HCM',
    location_city_codes: ['HCM'],
    role_code: 'backend_developer',
    experience_level: 'JUNIOR',
    work_mode: 'HYBRID',
    employment_type: 'FULL_TIME',
    salary_min: '1000',
    salary_max: '2000',
    salary_visible: true,
    currency: 'USD',
    source_url: null,
    posted_at: '2026-07-01T00:00:00.000Z',
    skills: [],
    ...overrides,
  };
}

function recommendation(
  jobId: string,
  rank: number,
  matchScore: number,
  recommendationScore: number,
  postedAt: string | null,
  salaryMax: number | null,
): JobRecommendation {
  return {
    job_id: jobId,
    slug: jobId,
    application_mode: 'EXTERNAL',
    saved: false,
    title: jobId,
    company_name: 'Acme',
    location: null,
    city_codes: [],
    role_code: 'backend_developer',
    experience_level: 'JUNIOR',
    work_mode: null,
    employment_type: null,
    salary_min: null,
    salary_max: salaryMax,
    salary_visible: salaryMax !== null,
    currency: 'VND',
    source_url: null,
    posted_at: postedAt,
    match_score: matchScore,
    recommendation_score: recommendationScore,
    severe_stretch: false,
    seniority_factor: 1,
    level_gap: 0,
    semantic_similarity: null,
    rank,
    matched_skills: [],
    partial_skills: [],
    missing_skills: [],
    scoring_breakdown: {} as never,
    experience_fit: {
      verdict: 'fits',
      cv_seniority: 'junior',
      job_level: 'JUNIOR',
      confidence: 'high',
    },
  };
}

describe('JobRecommendationQueryDto', () => {
  it('normalizes arrays, sort and booleans', () => {
    const dto = plainToInstance(JobRecommendationQueryDto, {
      limit: '20',
      offset: '5',
      role: 'BACKEND_DEVELOPER',
      cityCodes: 'hcm,Han,HCM',
      workModes: 'remote,hybrid',
      experienceLevels: ['junior'],
      fit: 'safe_apply,stretch',
      sort: 'newest',
      salaryOnly: 'true',
    });

    expect(validateSync(dto)).toHaveLength(0);
    expect(dto).toMatchObject({
      limit: 20,
      offset: 5,
      role: 'backend_developer',
      cityCodes: ['HCM', 'HAN'],
      workModes: ['REMOTE', 'HYBRID'],
      experienceLevels: ['JUNIOR'],
      fit: ['safe_apply', 'stretch'],
      sort: 'NEWEST',
      salaryOnly: true,
    });
  });

  it('rejects invalid role, sort and bounds instead of silently returning an empty pool', () => {
    const dto = plainToInstance(JobRecommendationQueryDto, {
      limit: '500',
      role: 'wizard',
      sort: 'random',
      salaryOnly: 'sometimes',
    });
    expect(
      validateSync(dto)
        .map((error) => error.property)
        .sort(),
    ).toEqual(['limit', 'role', 'salaryOnly', 'sort']);
  });
});

describe('job recommendation browse policy', () => {
  const rows = [
    candidate(),
    candidate({
      id: 'job-2',
      primary_city_code: 'HAN',
      location_city_codes: ['HAN'],
      work_mode: 'REMOTE',
      experience_level: 'SENIOR',
      salary_visible: false,
    }),
    candidate({
      id: 'job-3',
      primary_city_code: null,
      location_city_codes: [],
      location: 'A location string the city normalizer does not recognize',
      work_mode: null,
      experience_level: null,
      employment_type: null,
      salary_min: null,
      salary_max: null,
      salary_visible: false,
    }),
  ];

  it('applies metadata filters before scoring and does not include unknown values', () => {
    expect(
      filterCandidateJobs(rows, {
        cityCodes: ['HAN'],
        workModes: ['REMOTE'],
        experienceLevels: ['SENIOR'],
      }).map((row) => row.id),
    ).toEqual(['job-2']);
    expect(filterCandidateJobs(rows, { salaryOnly: true }).map((row) => row.id)).toEqual(['job-1']);
  });

  it('returns reproducible facets and explicit metadata gaps', () => {
    expect(buildMetadataFacets(rows)).toEqual({
      city_codes: [
        { value: 'HAN', count: 1 },
        { value: 'HCM', count: 1 },
      ],
      work_modes: [
        { value: 'HYBRID', count: 1 },
        { value: 'REMOTE', count: 1 },
      ],
      employment_types: [{ value: 'FULL_TIME', count: 2 }],
      experience_levels: [
        { value: 'JUNIOR', count: 1 },
        { value: 'SENIOR', count: 1 },
      ],
    });
    expect(buildRecommendationDataQuality(rows)).toEqual({
      missing_role: 0,
      missing_experience_level: 1,
      missing_location: 1,
      missing_work_mode: 1,
    });
  });

  it.each<[JobRecommendationSort, string[]]>([
    ['RECOMMENDED', ['a', 'b', 'c']],
    ['SKILL_MATCH', ['b', 'c', 'a']],
    ['NEWEST', ['c', 'b', 'a']],
    ['SALARY_DESC', ['c', 'b', 'a']],
  ])('sorts %s deterministically', (sort, expected) => {
    const rows = [
      recommendation('a', 1, 60, 90, '2026-01-01T00:00:00Z', 100),
      recommendation('b', 2, 95, 80, '2026-02-01T00:00:00Z', 200),
      recommendation('c', 3, 80, 70, '2026-03-01T00:00:00Z', 300),
    ];
    expect(sortRecommendations(rows, sort).map((row) => row.job_id)).toEqual(expected);
  });
});

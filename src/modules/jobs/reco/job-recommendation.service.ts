import {
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { DatabaseService } from '../../../infrastructure/database/database.service';
import { LlmService } from '../../../infrastructure/llm/llm.service';
import { SkillDiffService, DiffResult, RawCvSkill } from '../../cv-jd-match/skill-diff.service';
import { SkillTaxonomyService } from '../../../common/services/skill-taxonomy.service';
import { proficiencyHintForLevel } from '../../../common/services/proficiency-calibration';
import { rrfFuse } from './rrf';
import { CanonicalCvDocument } from '../../../common/types/canonical-cv';
import {
  loadLatestReviewSkills,
  toRawCvSkills,
  ScoreBasis,
} from '../../cv-jd-match/cv-review-facts';
import {
  deriveCvSeniority,
  computeExperienceFit,
  experienceNudge,
  recommendationSeniorityPolicy,
  ExperienceFit,
  CvSeniority,
} from '../../../common/services/seniority';
import { classifyFit, FitVerdict } from '../../gap-engine/fit-strategy';
import {
  fetchLatestInterviewSignalsForUser,
  InterviewSignalMap,
} from '../../../platform/interviews/interview-signals';
import {
  JobRecommendationSnapshot,
  JobRecommendationSnapshotStore,
} from './job-recommendation-snapshot.store';
import type { JobLocationRecord } from '../ingest/job-location';

export type WorkMode = 'ONSITE' | 'HYBRID' | 'REMOTE';
export type EmploymentType = 'FULL_TIME' | 'PART_TIME' | 'INTERNSHIP' | 'CONTRACT' | 'FREELANCE';
export type ExperienceLevel = 'INTERN' | 'FRESHER' | 'JUNIOR' | 'MIDDLE' | 'SENIOR' | 'LEAD';
export type JobRecommendationSort = 'RECOMMENDED' | 'SKILL_MATCH' | 'NEWEST' | 'SALARY_DESC';

export interface JobRecommendationOptions {
  snapshotToken?: string;
  limit?: number;
  offset?: number;
  /** Omitted = CV target role; "all" = explicitly browse every role. */
  roleCode?: string;
  /** Case-insensitive title/company search, applied after the stable snapshot is built. */
  query?: string;
  cityCodes?: string[];
  /** Source-provided city labels for locations that do not have a canonical city code yet. */
  cityNames?: string[];
  districtCodes?: string[];
  sourceNames?: string[];
  workModes?: WorkMode[];
  employmentTypes?: EmploymentType[];
  experienceLevels?: ExperienceLevel[];
  fit?: FitVerdict['verdict'][];
  postedFrom?: string;
  postedTo?: string;
  /** Monthly range; requires an explicit ISO-4217 currency to avoid cross-currency comparisons. */
  salaryMin?: number;
  salaryMax?: number;
  salaryCurrency?: string;
  sort?: JobRecommendationSort;
  salaryOnly?: boolean;
}

export interface JobRecommendationGenerationHooks {
  beforeGenerate?: () => Promise<void>;
}

export interface JobRecommendation {
  job_id: string;
  slug: string;
  application_mode: 'NATIVE' | 'EXTERNAL';
  saved: boolean;
  title: string;
  company_name: string;
  location: string | null;
  /** Source/catalog identifier used by the explorer filter. */
  source_name?: string | null;
  city_codes: string[];
  locations: JobRecommendationLocation[];
  role_code: string | null;
  experience_level: string | null;
  work_mode: WorkMode | null;
  employment_type: EmploymentType | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_visible: boolean;
  salary_period: 'MONTH' | 'YEAR' | null;
  currency: string;
  source_url: string | null;
  posted_at: string | null;
  /** Deterministic MATCH_TUNING score (0-100) — same engine as CV/JD match. SKILL match only;
   *  unchanged by the seniority guard so the card stays explainable. */
  match_score: number;
  /** Seniority-adjusted ranking score (0-100) = match_score × recommendation seniority factor.
   *  Equals match_score when the candidate fits; demoted for `stretch` (esp. severe). What the
   *  ranking is actually sorted by — surfaced so the FE can show why a high-skill job ranks low. */
  recommendation_score: number;
  /** True when the job sits ≥ 3 seniority levels above the candidate (e.g. fresher → LEAD) — a severe
   *  stretch the FE can badge / filter from the default list. */
  severe_stretch: boolean;
  /** E5: the recommendationSeniorityPolicy() multiplier applied to match_score → recommendation_score
   *  (1 = no demotion). Additive — lets the FE explain a demoted score instead of just showing it. */
  seniority_factor: number;
  /** E5: job_level rank − cv rank (positive = job sits above the candidate); 0 when seniority is
   *  unknown/neutral. Same value recommendationSeniorityPolicy() derived the factor from. */
  level_gap: number;
  /** Cosine similarity of skill-set embeddings (null when the job has no vector). */
  semantic_similarity: number | null;
  /** RRF-fused rank position (1 = best). */
  rank: number;
  matched_skills: string[];
  /** canonical_name is additive — the FE's stable list key (display_name may collide/localize). */
  partial_skills: Array<{
    canonical_name: string;
    display_name: string;
    importance: string;
    gap_levels: number;
  }>;
  missing_skills: Array<{ display_name: string; importance: string }>;
  /** Same breakdown the score was computed from — lets the FE detail match the card exactly. */
  scoring_breakdown: DiffResult['scoring_breakdown'];
  experience_fit: ExperienceFit;
  /** Wave ACTION (A1): deterministic safe_apply/stretch/not_recommended verdict, input score =
   *  recommendation_score (the seniority-adjusted ranking score, not the raw skill match_score).
   *  `fit.reasons[]` never includes DEAL_BREAKER_UNMET here — see the asymmetry note below.
   *  Optional (additive, same convention as jd_dimensions?/inferred_skills? elsewhere) — always
   *  populated on the live path, only absent for pre-A1 reconstructed/cached rows. */
  fit?: FitVerdict;
  /** RECOMMENDATION' (R2/R3): what entered recommendation_score — 'skills_and_seniority' when a
   *  real seniority verdict applied, 'skills_only' when seniority was unknown (factor 1). The
   *  deal-breaker basis is never emitted here (pool jobs carry no jd_dimensions). Optional for the
   *  same additive/cached-row convention as `fit`. */
  score_basis?: ScoreBasis;
  /** R4 (RECOMMENDATION'): requirements of THIS job the user's latest COMPLETED interview flagged
   *  as knowledge/evidence gaps (risk 0-1, worst per skill; session_ref = session id prefix).
   *  CONFIDENCE OVERLAY ONLY — never raises or lowers ranking in v1 (a weak interview must not
   *  silently bury a job). Absent when no completed interview, no overlap, or lookup failed. */
  interview_signals?: Array<{
    skill_canonical: string;
    /** human label (InterviewGapItem.display_name) — FE chips must never show the raw canonical. */
    display_name: string;
    risk: number;
    session_ref: string;
  }>;
}

export interface JobRecommendationLocation {
  country_code: string | null;
  city_code: string | null;
  city_name: string | null;
  district_code: string | null;
  district_name: string | null;
  address_line: string | null;
  is_primary: boolean;
  granularity: 'exact' | 'district' | 'city' | 'unknown';
}

export interface JobRecommendationResponse {
  cv_id: string;
  /** Size of the candidate pool considered (active/canonical, role-filtered). */
  pool_size: number;
  /** Jobs remaining after metadata filters, before optional fit filtering. */
  eligible_pool_size: number;
  /** Total ranked recommendations available — paginate with limit/offset to "see all". */
  total: number;
  /** Page size applied (default 5 for the headline; up to 50). */
  limit: number;
  /** Page offset applied (0-based). */
  offset: number;
  role_scope: {
    role_code: string | null;
    source: 'explicit' | 'cv_target' | 'all' | 'cv_target_missing';
  };
  filters_applied: {
    query: string | null;
    city_codes: string[];
    city_names: string[];
    district_codes: string[];
    source_names: string[];
    work_modes: WorkMode[];
    employment_types: EmploymentType[];
    experience_levels: ExperienceLevel[];
    fit: FitVerdict['verdict'][];
    posted_from: string | null;
    posted_to: string | null;
    salary_min: number | null;
    salary_max: number | null;
    salary_currency: string | null;
    salary_only: boolean;
    sort: JobRecommendationSort;
  };
  facets: {
    city_codes: Array<{ value: string; count: number }>;
    city_names: Array<{ value: string; count: number }>;
    district_codes: Array<{ value: string; count: number }>;
    source_names: Array<{ value: string; count: number }>;
    work_modes: Array<{ value: WorkMode; count: number }>;
    employment_types: Array<{ value: EmploymentType; count: number }>;
    experience_levels: Array<{ value: ExperienceLevel; count: number }>;
    fit: Array<{ value: FitVerdict['verdict']; count: number }>;
  };
  data_quality: {
    missing_role: number;
    missing_experience_level: number;
    missing_location: number;
    missing_city_code: number;
    missing_city_name: number;
    missing_district_code: number;
    missing_source_name: number;
    missing_posted_at: number;
    missing_work_mode: number;
    missing_employment_type: number;
    facet_coverage: {
      city_codes: number;
      city_names: number;
      district_codes: number;
      source_names: number;
      work_modes: number;
      employment_types: number;
      experience_levels: number;
    };
    salary_sort_supported: boolean;
  };
  generation: {
    cache_hit: boolean;
    snapshot_size: number;
    snapshot_token?: string;
  };
  recommendations: JobRecommendation[];
}

interface CandidateJobRow {
  id: string;
  slug: string;
  application_mode: 'NATIVE' | 'EXTERNAL';
  saved: boolean;
  title: string;
  company_name: string;
  location: string | null;
  primary_city_code?: string | null;
  location_city_codes?: string[];
  source_name?: string | null;
  published_locations?: CandidateLocation[];
  job_locations?: JobLocationRecord[];
  role_code: string | null;
  experience_level: string | null;
  work_mode?: WorkMode | null;
  employment_type?: EmploymentType | null;
  salary_min: string | null;
  salary_max: string | null;
  salary_visible: boolean;
  salary_period?: 'MONTH' | 'YEAR' | null;
  currency: string;
  source_url: string | null;
  posted_at: string | null;
  skills: Array<{ canonical: string; importance: string; min_level: number | null }>;
}

interface CandidateLocation {
  countryCode?: unknown;
  cityCode?: unknown;
  cityName?: unknown;
  districtCode?: unknown;
  districtName?: unknown;
  addressLine?: unknown;
  isPrimary?: unknown;
}

interface CvRecommendationRow {
  id: string;
  parsed_json: CanonicalCvDocument | null;
  target_role: string | null;
}

function countFacets<T extends string>(
  values: Array<T | null | undefined>,
): Array<{
  value: T;
  count: number;
}> {
  const counts = new Map<T, number>();
  for (const value of values) {
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

const LOCATION_CITY_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:ho chi minh(?: city)?|hcmc?|tp\.?\s*hcm|sai gon)\b/i, 'HCM'],
  [/\b(?:ha noi|hanoi)\b/i, 'HAN'],
  [/\b(?:da nang|danang)\b/i, 'DAD'],
  [/\b(?:hai phong|haiphong)\b/i, 'HPH'],
  [/\b(?:can tho|cantho)\b/i, 'CTO'],
  [/\b(?:binh duong)\b/i, 'BDG'],
  [/\b(?:dong nai)\b/i, 'DNI'],
  [/\b(?:ba ria|vung tau)\b/i, 'VTU'],
  [/\b(?:da lat|lam dong)\b/i, 'DLI'],
];

function foldLocation(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd');
}

export function normalizeLocationCityCodes(location: string | null | undefined): string[] {
  if (!location) return [];
  const folded = foldLocation(location);
  return LOCATION_CITY_PATTERNS.filter(([pattern]) => pattern.test(folded)).map(([, code]) => code);
}

function jobCityCodes(job: CandidateJobRow): string[] {
  const structured = [
    ...new Set(
      [
        job.primary_city_code,
        ...(job.location_city_codes ?? []),
        ...(job.published_locations ?? []).map((location) => location.cityCode),
        ...(job.job_locations ?? []).map((location) => location.cityCode),
      ]
        .filter((value): value is string => Boolean(value))
        .map((value) => value.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
  return structured.length > 0 ? structured : normalizeLocationCityCodes(job.location);
}

function cleanLocationText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function buildRecommendationLocations(job: CandidateJobRow): JobRecommendationLocation[] {
  const published =
    Array.isArray(job.published_locations) && job.published_locations.length > 0
      ? job.published_locations
      : Array.isArray(job.job_locations)
        ? job.job_locations
        : [];
  const structured = published
    .map((location): JobRecommendationLocation | null => {
      const countryCode = cleanLocationText(location.countryCode)?.toUpperCase() ?? null;
      const cityCode = cleanLocationText(location.cityCode)?.toUpperCase() ?? null;
      const cityName = cleanLocationText(location.cityName);
      const districtCode = cleanLocationText(location.districtCode)?.toUpperCase() ?? null;
      const districtName = cleanLocationText(location.districtName);
      const addressLine = cleanLocationText(location.addressLine);

      if (!countryCode && !cityCode && !cityName && !districtCode && !districtName && !addressLine)
        return null;

      return {
        country_code: countryCode,
        city_code: cityCode,
        city_name: cityName,
        district_code: districtCode,
        district_name: districtName,
        address_line: addressLine,
        is_primary: location.isPrimary === true,
        granularity: addressLine
          ? 'exact'
          : districtCode || districtName
            ? 'district'
            : cityCode
              ? 'city'
              : 'unknown',
      };
    })
    .filter((location): location is JobRecommendationLocation => location !== null);

  if (structured.length > 0) return structured;

  // External/crawled jobs often expose only a city. Never promote their free-form
  // location label to an exact address because its provenance is not strong enough.
  const cityCodes = jobCityCodes(job);
  if (cityCodes.length === 0) {
    const rawLocation = cleanLocationText(job.location);
    return rawLocation
      ? [
          {
            country_code: null,
            city_code: null,
            city_name: rawLocation,
            district_code: null,
            district_name: null,
            address_line: null,
            is_primary: true,
            granularity: 'unknown',
          },
        ]
      : [];
  }

  return cityCodes.map((cityCode, index) => ({
    country_code: null,
    city_code: cityCode,
    city_name: null,
    district_code: null,
    district_name: null,
    address_line: null,
    is_primary: index === 0,
    granularity: 'city',
  }));
}

function compareNullableDateDesc(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return Date.parse(b) - Date.parse(a);
}

function visibleSalaryValue(job: JobRecommendation): number | null {
  if (!job.salary_visible) return null;
  const value = job.salary_max ?? job.salary_min;
  if (value == null) return null;
  return job.salary_period === 'YEAR' ? value / 12 : value;
}

export function sortJobRecommendations(
  recommendations: JobRecommendation[],
  sort: JobRecommendationSort,
): JobRecommendation[] {
  if (sort === 'SALARY_DESC') {
    const salaryRows = recommendations.filter(hasVisibleRecommendationSalary);
    const currencies = new Set(salaryRows.map((row) => row.currency));
    if (
      salaryRows.length === 0 ||
      currencies.size !== 1 ||
      salaryRows.some((row) => row.salary_period == null)
    ) {
      return [...recommendations].sort(
        (a, b) => a.rank - b.rank || a.job_id.localeCompare(b.job_id),
      );
    }
  }
  return [...recommendations].sort((a, b) => {
    if (sort === 'SKILL_MATCH') {
      return b.match_score - a.match_score || a.rank - b.rank || a.job_id.localeCompare(b.job_id);
    }
    if (sort === 'NEWEST') {
      return (
        compareNullableDateDesc(a.posted_at, b.posted_at) ||
        a.rank - b.rank ||
        a.job_id.localeCompare(b.job_id)
      );
    }
    if (sort === 'SALARY_DESC') {
      const salaryA = visibleSalaryValue(a);
      const salaryB = visibleSalaryValue(b);
      if (salaryA == null && salaryB != null) return 1;
      if (salaryA != null && salaryB == null) return -1;
      return (salaryB ?? 0) - (salaryA ?? 0) || a.rank - b.rank || a.job_id.localeCompare(b.job_id);
    }
    return a.rank - b.rank || a.job_id.localeCompare(b.job_id);
  });
}

type MetadataDimension =
  | 'city'
  | 'city_name'
  | 'district'
  | 'source'
  | 'work_mode'
  | 'employment_type'
  | 'experience_level'
  | 'fit';

function normalizedSearchText(value: string | null | undefined): string {
  return foldLocation(value ?? '')
    .toLocaleLowerCase('en-US')
    .trim();
}

function rowDistrictCodes(row: JobRecommendation): string[] {
  return [
    ...new Set(
      row.locations
        .map((location) => location.district_code)
        .filter((value): value is string => Boolean(value))
        .map((value) => value.toUpperCase()),
    ),
  ];
}

function rowCityNames(row: JobRecommendation): string[] {
  return [
    ...new Set(
      row.locations
        .map((location) => location.city_name?.trim() || null)
        .filter((value): value is string => value != null),
    ),
  ];
}

function rowSourceName(row: JobRecommendation): string | null {
  const source = row.source_name?.trim().toLocaleLowerCase('en-US');
  return source || null;
}

function normalizeRecommendationSourceName(
  sourceName: string | null | undefined,
  applicationMode: CandidateJobRow['application_mode'],
): string | null {
  // Employer rows contain an internal company identifier in source_name. Do not expose that
  // identifier as a user-facing filter value; the explorer contract uses a stable catalog name.
  if (applicationMode === 'NATIVE') return 'business';
  const source = sourceName?.trim().toLocaleLowerCase('en-US');
  return source || null;
}

function normalizeSnapshotLocation(
  location: Partial<JobRecommendationLocation>,
): JobRecommendationLocation {
  return {
    country_code: location.country_code ?? null,
    city_code: location.city_code ?? null,
    city_name: location.city_name ?? null,
    district_code: location.district_code ?? null,
    district_name: location.district_name ?? null,
    address_line: location.address_line ?? null,
    is_primary: location.is_primary === true,
    granularity: location.granularity ?? 'unknown',
  };
}

function normalizeSnapshotRecommendation(row: JobRecommendation): JobRecommendation {
  const sourceName = normalizeRecommendationSourceName(row.source_name, row.application_mode);
  return {
    ...row,
    ...(sourceName ? { source_name: sourceName } : { source_name: null }),
    locations: (row.locations ?? []).map((location) => normalizeSnapshotLocation(location)),
  };
}

function rowSearchText(row: JobRecommendation): string[] {
  return [
    row.title,
    row.company_name,
    row.location,
    row.source_name,
    ...row.city_codes,
    ...row.locations.flatMap((location) => [
      location.city_name,
      location.city_code,
      location.district_name,
      location.district_code,
      location.address_line,
    ]),
  ].filter((value): value is string => Boolean(value));
}

function isPostedInRange(row: JobRecommendation, options: JobRecommendationOptions): boolean {
  if (!options.postedFrom && !options.postedTo) return true;
  if (!row.posted_at) return false;
  const postedAt = Date.parse(row.posted_at);
  if (!Number.isFinite(postedAt)) return false;
  if (options.postedFrom && postedAt < Date.parse(options.postedFrom)) return false;
  if (options.postedTo && postedAt > Date.parse(options.postedTo)) return false;
  return true;
}

function salaryRangeInMonthlyUnits(row: JobRecommendation): [number | null, number | null] {
  const min = row.salary_min == null ? null : Number(row.salary_min);
  const max = row.salary_max == null ? null : Number(row.salary_max);
  if ((min != null && !Number.isFinite(min)) || (max != null && !Number.isFinite(max))) {
    return [null, null];
  }
  const divisor = row.salary_period === 'YEAR' ? 12 : 1;
  return [min == null ? null : min / divisor, max == null ? null : max / divisor];
}

function isSalaryInRange(row: JobRecommendation, options: JobRecommendationOptions): boolean {
  if (options.salaryMin == null && options.salaryMax == null) return true;
  if (!hasVisibleRecommendationSalary(row) || !options.salaryCurrency) return false;
  if (row.currency.toUpperCase() !== options.salaryCurrency.toUpperCase()) return false;
  const [rowMin, rowMax] = salaryRangeInMonthlyUnits(row);
  const requestedMin = options.salaryMin ?? 0;
  const requestedMax = options.salaryMax ?? Number.POSITIVE_INFINITY;
  const comparableMin = rowMin ?? 0;
  const comparableMax = rowMax ?? Number.POSITIVE_INFINITY;
  return comparableMin <= requestedMax && comparableMax >= requestedMin;
}

function applyRecommendationFilters(
  rows: JobRecommendation[],
  options: JobRecommendationOptions,
  omit?: MetadataDimension,
): JobRecommendation[] {
  const cityCodes = new Set(options.cityCodes ?? []);
  const cityNames = new Set((options.cityNames ?? []).map((value) => normalizedSearchText(value)));
  const districtCodes = new Set(options.districtCodes ?? []);
  const sourceNames = new Set((options.sourceNames ?? []).map((value) => value.toLowerCase()));
  const workModes = new Set(options.workModes ?? []);
  const employmentTypes = new Set(options.employmentTypes ?? []);
  const experienceLevels = new Set(options.experienceLevels ?? []);
  const fit = new Set(options.fit ?? []);

  return rows.filter((row) => {
    if (
      options.query &&
      !rowSearchText(row).some((value) =>
        normalizedSearchText(value).includes(normalizedSearchText(options.query)),
      )
    ) {
      return false;
    }
    if (omit !== 'city' && cityCodes.size > 0 && !row.city_codes.some((x) => cityCodes.has(x))) {
      return false;
    }
    if (
      omit !== 'city_name' &&
      cityNames.size > 0 &&
      !rowCityNames(row).some((name) => cityNames.has(normalizedSearchText(name)))
    ) {
      return false;
    }
    if (
      omit !== 'district' &&
      districtCodes.size > 0 &&
      !rowDistrictCodes(row).some((code) => districtCodes.has(code))
    ) {
      return false;
    }
    if (
      omit !== 'source' &&
      sourceNames.size > 0 &&
      (!rowSourceName(row) || !sourceNames.has(rowSourceName(row)!))
    ) {
      return false;
    }
    if (
      omit !== 'work_mode' &&
      workModes.size > 0 &&
      (!row.work_mode || !workModes.has(row.work_mode))
    ) {
      return false;
    }
    if (
      omit !== 'employment_type' &&
      employmentTypes.size > 0 &&
      (!row.employment_type || !employmentTypes.has(row.employment_type))
    ) {
      return false;
    }
    if (
      omit !== 'experience_level' &&
      experienceLevels.size > 0 &&
      (!row.experience_level || !experienceLevels.has(row.experience_level as ExperienceLevel))
    ) {
      return false;
    }
    if (omit !== 'fit' && fit.size > 0 && (!row.fit?.verdict || !fit.has(row.fit.verdict))) {
      return false;
    }
    if (!isPostedInRange(row, options)) return false;
    if (!isSalaryInRange(row, options)) return false;
    if (options.salaryOnly && !hasVisibleRecommendationSalary(row)) return false;
    return true;
  });
}

function hasVisibleRecommendationSalary(row: JobRecommendation): boolean {
  return row.salary_visible && (row.salary_min != null || row.salary_max != null);
}

function ratio(present: number, total: number): number {
  return total === 0 ? 0 : Number((present / total).toFixed(3));
}

export function projectJobRecommendationSnapshot(
  cvId: string,
  snapshot: JobRecommendationSnapshot,
  options: JobRecommendationOptions,
  cacheHit: boolean,
): JobRecommendationResponse {
  const limit = Math.min(Math.max(Number(options.limit) || 5, 1), 50);
  const offset = Math.max(Number(options.offset) || 0, 0);
  const explicitRole = options.roleCode && options.roleCode !== 'all' ? options.roleCode : null;
  const scopedRole = (roleCode: string): JobRecommendation[] => {
    const ids = snapshot.recommendation_ids_by_role?.[roleCode];
    if (!ids) return snapshot.recommendations.filter((row) => row.role_code === roleCode);
    const byId = new Map(snapshot.recommendations.map((row) => [row.job_id, row]));
    return ids.flatMap((id, index) => {
      const row = byId.get(id);
      return row ? [{ ...row, rank: index + 1 }] : [];
    });
  };

  let roleScope: JobRecommendationResponse['role_scope'];
  let scoped: JobRecommendation[];
  if (explicitRole) {
    roleScope = { role_code: explicitRole, source: 'explicit' };
    scoped = scopedRole(explicitRole);
  } else if (options.roleCode === 'all') {
    roleScope = { role_code: null, source: 'all' };
    scoped = snapshot.recommendations;
  } else if (snapshot.cv_target_role) {
    roleScope = { role_code: snapshot.cv_target_role, source: 'cv_target' };
    scoped = scopedRole(snapshot.cv_target_role);
  } else {
    roleScope = { role_code: null, source: 'cv_target_missing' };
    scoped = [];
  }

  // Snapshots created before structured locations were introduced remain readable.
  scoped = scoped.map(normalizeSnapshotRecommendation);

  const filtersApplied: JobRecommendationResponse['filters_applied'] = {
    query: options.query?.trim() || null,
    city_codes: options.cityCodes ?? [],
    city_names: options.cityNames ?? [],
    district_codes: options.districtCodes ?? [],
    source_names: options.sourceNames ?? [],
    work_modes: options.workModes ?? [],
    employment_types: options.employmentTypes ?? [],
    experience_levels: options.experienceLevels ?? [],
    fit: options.fit ?? [],
    posted_from: options.postedFrom ?? null,
    posted_to: options.postedTo ?? null,
    salary_min: options.salaryMin ?? null,
    salary_max: options.salaryMax ?? null,
    salary_currency: options.salaryCurrency ?? null,
    salary_only: options.salaryOnly ?? false,
    sort: options.sort ?? 'RECOMMENDED',
  };
  const metadataFiltered = applyRecommendationFilters(scoped, { ...options, fit: [] });
  const filtered = applyRecommendationFilters(scoped, options);
  const currencies = new Set(
    filtered.filter(hasVisibleRecommendationSalary).map((row) => row.currency),
  );
  const salaryRows = filtered.filter(hasVisibleRecommendationSalary);
  const facetCoverage = {
    city_codes: ratio(scoped.filter((row) => row.city_codes.length > 0).length, scoped.length),
    city_names: ratio(scoped.filter((row) => rowCityNames(row).length > 0).length, scoped.length),
    district_codes: ratio(
      scoped.filter((row) => rowDistrictCodes(row).length > 0).length,
      scoped.length,
    ),
    source_names: ratio(scoped.filter((row) => rowSourceName(row) != null).length, scoped.length),
    work_modes: ratio(scoped.filter((row) => row.work_mode).length, scoped.length),
    employment_types: ratio(scoped.filter((row) => row.employment_type).length, scoped.length),
    experience_levels: ratio(scoped.filter((row) => row.experience_level).length, scoped.length),
  };

  const sorted = sortJobRecommendations(filtered, options.sort ?? 'RECOMMENDED');
  return {
    cv_id: cvId,
    pool_size: scoped.length,
    eligible_pool_size: metadataFiltered.length,
    total: sorted.length,
    limit,
    offset,
    role_scope: roleScope,
    filters_applied: filtersApplied,
    facets: {
      city_codes: countFacets(
        applyRecommendationFilters(scoped, options, 'city').flatMap((row) => row.city_codes),
      ),
      city_names: countFacets(
        applyRecommendationFilters(scoped, options, 'city_name').flatMap((row) =>
          rowCityNames(row),
        ),
      ),
      district_codes: countFacets(
        applyRecommendationFilters(scoped, options, 'district').flatMap((row) =>
          rowDistrictCodes(row),
        ),
      ),
      source_names: countFacets(
        applyRecommendationFilters(scoped, options, 'source')
          .map((row) => rowSourceName(row))
          .filter((value): value is string => value != null),
      ),
      work_modes: countFacets(
        applyRecommendationFilters(scoped, options, 'work_mode').map((row) => row.work_mode),
      ),
      employment_types: countFacets(
        applyRecommendationFilters(scoped, options, 'employment_type').map(
          (row) => row.employment_type,
        ),
      ),
      experience_levels: countFacets(
        applyRecommendationFilters(scoped, options, 'experience_level').map(
          (row) => row.experience_level as ExperienceLevel | null,
        ),
      ),
      fit: countFacets(
        applyRecommendationFilters(scoped, options, 'fit').map((row) => row.fit?.verdict),
      ),
    },
    data_quality: {
      missing_role: scoped.filter((row) => !row.role_code).length,
      missing_experience_level: scoped.filter((row) => !row.experience_level).length,
      missing_location: scoped.filter((row) => !row.location && row.locations.length === 0).length,
      missing_city_code: scoped.filter((row) => row.city_codes.length === 0).length,
      missing_city_name: scoped.filter((row) => rowCityNames(row).length === 0).length,
      missing_district_code: scoped.filter((row) => rowDistrictCodes(row).length === 0).length,
      missing_source_name: scoped.filter((row) => rowSourceName(row) == null).length,
      missing_posted_at: scoped.filter((row) => !row.posted_at).length,
      missing_work_mode: scoped.filter((row) => !row.work_mode).length,
      missing_employment_type: scoped.filter((row) => !row.employment_type).length,
      facet_coverage: facetCoverage,
      salary_sort_supported:
        salaryRows.length > 0 &&
        currencies.size === 1 &&
        salaryRows.every((row) => row.salary_period != null),
    },
    generation: {
      cache_hit: cacheHit,
      snapshot_size: snapshot.recommendations.length,
      ...(snapshot.snapshot_token ? { snapshot_token: snapshot.snapshot_token } : {}),
    },
    recommendations: sorted.slice(offset, offset + limit),
  };
}

/**
 * Seniority-aware re-rank: adjusted = rrf × seniorityFactor + experienceNudge; sort desc, stable by id.
 *
 *  - The MULTIPLICATIVE factor (recommendationSeniorityPolicy) is a real demotion: a `stretch` job is
 *    scaled by 0.4–0.85, which reliably sinks it BELOW every full-factor (`fits`/`unknown`/`over`) job
 *    — so a fresher does not get SENIOR/LEAD jobs as normal top recommendations even on high skill
 *    overlap. Within one factor tier the RRF order (skill + semantic) is preserved (constant multiplier).
 *  - The additive nudge is retained as the original ~one-rank-step tie-breaker among same-factor jobs.
 *  When the whole pool is a stretch (e.g. only senior jobs exist), they are demoted equally and still
 *  surface — honest — flagged via `severe_stretch` on the response rather than hidden.
 */
export function rerankByExperience(
  fused: Map<string, number>,
  fitByJob: Map<string, ExperienceFit>,
): Array<[string, number]> {
  return [...fused.entries()]
    .map(([id, score]): [string, number] => {
      const fit = fitByJob.get(id);
      const { factor } = recommendationSeniorityPolicy(fit);
      return [id, score * factor + experienceNudge(fit)];
    })
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * Top-N job recommendations for a CV (J4) — HYBRID retrieval over the jobs pool:
 *
 *   signal A (sparse/deterministic): SkillDiffService with MATCH_TUNING — the SAME
 *     eval-gated engine as CV/JD match (importance multipliers, convex partial credit,
 *     required-coverage cap). Reproducible, explainable (matched/missing skills).
 *   signal B (dense): cosine between the CV's skill-set embedding and job_embeddings
 *     (same tuple as skill_embeddings — one geometry across CV/skill/job vectors).
 *   fusion: RRF (rank-based — no cross-signal score normalization needed).
 *
 * Pool filter: status='active', not expired, canonical representatives only
 * (canonical_job_id IS NULL — cross-board duplicates collapse to one entry).
 * Jobs without an embedding still compete via signal A alone (graceful degradation).
 */
@Injectable()
export class JobRecommendationService {
  private readonly logger = new Logger(JobRecommendationService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
    private readonly llm: LlmService,
    private readonly skillDiff: SkillDiffService,
    private readonly taxonomy: SkillTaxonomyService,
    private readonly snapshots: JobRecommendationSnapshotStore,
  ) {}

  async recommendForCv(
    userId: string,
    cvId: string,
    options: JobRecommendationOptions = {},
    hooks: JobRecommendationGenerationHooks = {},
  ): Promise<JobRecommendationResponse> {
    // 1. Ownership + CV skills (persisted by the CV review pipeline).
    const cvRows = await this.db.query<CvRecommendationRow>(
      `SELECT id, parsed_json, target_role
         FROM public.cvs
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [cvId, userId],
    );
    if (cvRows.length === 0) {
      throw new NotFoundException({ code: 'CV_NOT_FOUND', message: 'CV not found' });
    }
    const cvSeniority: CvSeniority | null = cvRows[0].parsed_json
      ? deriveCvSeniority(cvRows[0].parsed_json)
      : null;
    const cvTargetRole = cvRows[0].target_role?.trim() || null;

    // A stable explorer page does not need to rebuild or reload the recommendation pool.
    // Keep the ownership check above, then hydrate only mutable saved-state for the jobs
    // present in the stored page. This makes snapshot pagination proportional to page size.
    if (options.snapshotToken) {
      const stableSnapshot = await this.snapshots.findByToken(userId, cvId, options.snapshotToken);
      if (!stableSnapshot) {
        throw new GoneException({
          code: 'JOB_RECOMMENDATION_SNAPSHOT_EXPIRED',
          message: 'This recommendation snapshot expired. Refresh to load a new result set.',
        });
      }
      return this.withPersistedSavedState(
        userId,
        projectJobRecommendationSnapshot(cvId, stableSnapshot, options, true),
      );
    }

    const cvSkillRows = await this.db.query<{ canonical_name: string }>(
      `SELECT s.canonical_name
         FROM public.cv_skills cs JOIN public.skills s ON s.id = cs.skill_id
        WHERE cs.cv_id = $1`,
      [cvId],
    );
    const cvCanonicals = cvSkillRows.map((r) => r.canonical_name);

    // 2. Candidate pool (active, unexpired, canonical representatives, with their skills).
    const allCandidates = await this.db.query<CandidateJobRow>(
      `SELECT j.id, j.slug, j.application_mode,
              EXISTS (SELECT 1 FROM public.saved_jobs sj WHERE sj.job_id = j.id AND sj.user_id = $1) AS saved,
              j.title, c.name AS company_name, j.location, j.primary_city_code,
              j.location_city_codes,
              j.source_name,
              COALESCE(j.locations, '[]'::jsonb) AS job_locations,
              COALESCE(jpv.locations, '[]'::jsonb) AS published_locations,
              j.role_code, j.experience_level, j.work_mode,
              j.employment_type, j.salary_min, j.salary_max, j.salary_visible, j.salary_period,
              j.currency, j.source_url,
              j.posted_at::text AS posted_at,
              COALESCE(
                json_agg(
                  json_build_object('canonical', s.canonical_name, 'importance', js.importance, 'min_level', js.min_level)
                  ORDER BY s.canonical_name
                )
                  FILTER (WHERE s.id IS NOT NULL),
                '[]'
              ) AS skills
         FROM public.jobs j
         JOIN public.companies c ON c.id = j.company_id
         LEFT JOIN public.job_post_versions jpv
           ON jpv.id = j.current_published_version_id
          AND jpv.job_id = j.id
          AND jpv.status = 'PUBLISHED'
         LEFT JOIN public.job_skills js ON js.job_id = j.id
         LEFT JOIN public.skills s ON s.id = js.skill_id
        WHERE j.status = 'active'
          AND (j.expires_at IS NULL OR j.expires_at > now())
          AND j.canonical_job_id IS NULL
          AND (
            j.application_mode = 'EXTERNAL'
            OR EXISTS (
              SELECT 1 FROM public.business_profiles bp
               WHERE bp.company_id = j.company_id AND bp.status = 'VERIFIED'
            )
          )
        GROUP BY j.id, c.name, jpv.locations
        ORDER BY j.id`, // deterministic source order → reproducible RRF for tied scores
      [userId],
    );

    const requestedRole =
      options.roleCode && options.roleCode !== 'all' ? options.roleCode : cvTargetRole;
    if (
      options.roleCode !== 'all' &&
      (!requestedRole || !allCandidates.some((candidate) => candidate.role_code === requestedRole))
    ) {
      return projectJobRecommendationSnapshot(
        cvId,
        { cv_target_role: cvTargetRole, recommendations: [] },
        options,
        true,
      );
    }
    const reviewSkills = await loadLatestReviewSkills(this.db, userId, cvId);
    const cvSkillsRaw: RawCvSkill[] = toRawCvSkills(reviewSkills, cvCanonicals);
    const interviewSignals =
      (await fetchLatestInterviewSignalsForUser(this.db, userId)) ?? new Map();
    const inputFingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          cv: cvRows[0].parsed_json,
          cv_target_role: cvTargetRole,
          skills: [...cvCanonicals].sort(),
          proficiency: [...cvSkillsRaw].sort((a, b) => a.name.localeCompare(b.name)),
          interview: [...interviewSignals.entries()].sort(([a], [b]) => a.localeCompare(b)),
          embedding: {
            provider: this.config.get<string>('llm.providerDefault') ?? 'openai',
            model: this.config.get<string>('llm.openai.modelEmbedding') ?? '',
            dimension: this.config.get<number>('vector.dimension') ?? null,
            version: this.config.get<string>('vector.embeddingVersion') ?? 'v1',
          },
          recommendation_projection_version: 3,
          jobs: allCandidates.map((job) => ({
            id: job.id,
            slug: job.slug,
            title: job.title,
            company_name: job.company_name,
            location: job.location,
            primary_city_code: job.primary_city_code,
            location_city_codes: job.location_city_codes,
            source_name: job.source_name,
            job_locations: job.job_locations,
            published_locations: job.published_locations,
            role_code: job.role_code,
            experience_level: job.experience_level,
            work_mode: job.work_mode,
            employment_type: job.employment_type,
            application_mode: job.application_mode,
            salary_min: job.salary_min,
            salary_max: job.salary_max,
            salary_visible: job.salary_visible,
            salary_period: job.salary_period,
            currency: job.currency,
            source_url: job.source_url,
            posted_at: job.posted_at,
            skills: [...job.skills].sort((a, b) => a.canonical.localeCompare(b.canonical)),
          })),
        }),
      )
      .digest('hex');

    let cacheHit = true;
    let snapshot = await this.snapshots.find(userId, cvId, inputFingerprint);
    if (!snapshot) {
      const claimToken = await this.snapshots.tryClaim(userId, cvId, inputFingerprint);
      if (claimToken) {
        cacheHit = false;
        try {
          await hooks.beforeGenerate?.();
          snapshot = await this.buildSnapshot(
            cvTargetRole,
            cvCanonicals,
            cvSkillsRaw,
            cvSeniority,
            allCandidates,
            interviewSignals,
          );
          snapshot.snapshot_token = claimToken;
          const saved = await this.snapshots.save(
            userId,
            cvId,
            inputFingerprint,
            snapshot,
            claimToken,
          );
          if (!saved) {
            snapshot = await this.snapshots.waitFor(userId, cvId, inputFingerprint);
            if (!snapshot) {
              throw new ServiceUnavailableException({
                code: 'JOB_RECOMMENDATION_BUILD_LEASE_LOST',
                message: 'Job recommendation generation was superseded. Please retry shortly.',
              });
            }
            cacheHit = true;
          }
        } catch (error) {
          await this.snapshots.releaseClaim(userId, cvId, inputFingerprint, claimToken);
          throw error;
        }
      } else {
        snapshot = await this.snapshots.waitFor(userId, cvId, inputFingerprint);
        if (!snapshot) {
          throw new ServiceUnavailableException({
            code: 'JOB_RECOMMENDATION_GENERATION_IN_PROGRESS',
            message: 'Job recommendations are still being generated. Please retry shortly.',
          });
        }
      }
    }

    const projected = projectJobRecommendationSnapshot(cvId, snapshot, options, cacheHit);
    return this.withCurrentSavedState(projected, allCandidates);
  }

  private withCurrentSavedState(
    projected: JobRecommendationResponse,
    allCandidates: CandidateJobRow[],
  ): JobRecommendationResponse {
    const currentSavedByJob = new Map(allCandidates.map((job) => [job.id, job.saved]));
    return {
      ...projected,
      recommendations: projected.recommendations.map((recommendation) => ({
        ...recommendation,
        saved: currentSavedByJob.get(recommendation.job_id) ?? recommendation.saved,
      })),
    };
  }

  private async withPersistedSavedState(
    userId: string,
    projected: JobRecommendationResponse,
  ): Promise<JobRecommendationResponse> {
    const jobIds = projected.recommendations.map((recommendation) => recommendation.job_id);
    if (jobIds.length === 0) return projected;

    const savedRows = await this.db.query<{ job_id: string }>(
      `SELECT job_id
         FROM public.saved_jobs
        WHERE user_id = $1 AND job_id = ANY($2::uuid[])`,
      [userId, jobIds],
    );
    const savedJobIds = new Set(savedRows.map((row) => row.job_id));
    return {
      ...projected,
      recommendations: projected.recommendations.map((recommendation) => ({
        ...recommendation,
        saved: savedJobIds.has(recommendation.job_id),
      })),
    };
  }

  private async buildSnapshot(
    cvTargetRole: string | null,
    cvCanonicals: string[],
    cvSkillsRaw: RawCvSkill[],
    cvSeniority: CvSeniority | null,
    candidates: CandidateJobRow[],
    interviewSignals: InterviewSignalMap,
  ): Promise<JobRecommendationSnapshot> {
    if (candidates.length === 0 || cvCanonicals.length === 0) {
      return { cv_target_role: cvTargetRole, recommendations: [] };
    }

    const diffByJob = new Map<string, ReturnType<SkillDiffService['diff']>>();
    for (const job of candidates) {
      diffByJob.set(
        job.id,
        this.skillDiff.diff({
          cv_skills_raw: cvSkillsRaw,
          jd_requirements_raw: job.skills.map((skill) => ({
            name: skill.canonical,
            importance_hint: skill.importance,
            required_level_hint: proficiencyHintForLevel(skill.min_level),
          })),
        }),
      );
    }
    const rankA = [...candidates]
      .sort(
        (a, b) =>
          (diffByJob.get(b.id)!.overall_score ?? 0) - (diffByJob.get(a.id)!.overall_score ?? 0) ||
          a.id.localeCompare(b.id),
      )
      .map((job) => job.id);

    let rankB: string[] = [];
    const simByJob = new Map<string, number>();
    try {
      const model =
        this.config.get<string>('llm.openai.modelEmbedding') ?? 'text-embedding-3-large';
      const dimensions = this.config.get<number>('vector.dimension') ?? 1024;
      const version = this.config.get<string>('vector.embeddingVersion') ?? 'v1';
      const cvText = cvCanonicals
        .map((canonical) => this.taxonomy.getByCanonical(canonical)?.display_name ?? canonical)
        .sort((a, b) => a.localeCompare(b, 'en'))
        .join(', ');
      const { embedding } = await this.llm.embed(cvText, { provider: 'openai', dimensions });
      const simRows = await this.db.query<{ job_id: string; similarity: number }>(
        `SELECT job_id, 1 - (embedding <=> $1::extensions.vector) AS similarity
           FROM public.job_embeddings
          WHERE model = $2 AND dimensions = $3 AND embedding_version = $4
            AND job_id = ANY($5)
          ORDER BY embedding <=> $1::extensions.vector`,
        [
          `[${embedding.join(',')}]`,
          model,
          dimensions,
          version,
          candidates.map((candidate) => candidate.id),
        ],
      );
      for (const row of simRows) {
        simByJob.set(row.job_id, Number(row.similarity));
        rankB.push(row.job_id);
      }
    } catch (error) {
      this.logger.warn(
        `dense signal degraded (skill-match-only ranking): ${(error as Error).message}`,
      );
      rankB = [];
    }

    const fitByJob = new Map<string, ExperienceFit>(
      candidates.map((candidate) => [
        candidate.id,
        computeExperienceFit(cvSeniority, candidate.experience_level),
      ]),
    );
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const rankIds = (scopeCandidates: CandidateJobRow[]): string[] => {
      const scopeIds = new Set(scopeCandidates.map((candidate) => candidate.id));
      const scopeRankA = rankA.filter((id) => scopeIds.has(id));
      const scopeRankB = rankB.filter((id) => scopeIds.has(id));
      return rerankByExperience(
        rrfFuse(scopeRankB.length > 0 ? [scopeRankA, scopeRankB] : [scopeRankA]),
        fitByJob,
      ).map(([jobId]) => jobId);
    };
    const buildRankedRecommendations = (rankedIds: string[]): JobRecommendation[] =>
      rankedIds.map((jobId, index) =>
        buildJobRecommendation(
          byId.get(jobId)!,
          diffByJob.get(jobId)!,
          index + 1,
          simByJob.has(jobId) ? Number(simByJob.get(jobId)!.toFixed(4)) : null,
          fitByJob.get(jobId)!,
          interviewSignals,
        ),
      );

    const candidatesByRole = new Map<string, CandidateJobRow[]>();
    for (const candidate of candidates) {
      if (!candidate.role_code) continue;
      const group = candidatesByRole.get(candidate.role_code) ?? [];
      group.push(candidate);
      candidatesByRole.set(candidate.role_code, group);
    }
    const recommendationIdsByRole = Object.fromEntries(
      [...candidatesByRole.entries()].map(([role, rows]) => [role, rankIds(rows)]),
    );
    const rankedIds = rankIds(candidates);

    return {
      cv_target_role: cvTargetRole,
      recommendations: buildRankedRecommendations(rankedIds),
      recommendation_ids_by_role: recommendationIdsByRole,
    };
  }
}

/** Pure mapper: candidate row + its diff → API shape. Card and FE detail use the SAME diff. */
export function buildJobRecommendation(
  job: CandidateJobRow,
  diff: DiffResult,
  rank: number,
  semanticSimilarity: number | null,
  experienceFit: ExperienceFit,
  interviewSignals?: InterviewSignalMap,
): JobRecommendation {
  // R4: intersect the user's latest-interview risk map with THIS job's requirements. Annotation
  // only — computed after every score above is final, omitted (not []) when nothing overlaps.
  const interview_signals = interviewSignals
    ? job.skills
        .filter((s) => interviewSignals.has(s.canonical))
        .map((s) => {
          const signal = interviewSignals.get(s.canonical)!;
          return {
            skill_canonical: s.canonical,
            display_name: signal.display,
            risk: signal.risk,
            session_ref: signal.ref,
          };
        })
    : [];
  const policy = recommendationSeniorityPolicy(experienceFit);
  const sourceName = normalizeRecommendationSourceName(job.source_name, job.application_mode);
  // ponytail: null overall_score (job with no scorable requirements) coerces to 0 — byte-identical
  // to pre-TRUST-prime behavior for such jobs. Honest-null on job cards = RECOMMENDATION wave.
  const recommendation_score = Math.round((diff.overall_score ?? 0) * policy.factor);
  // ponytail: unmet_deal_breakers is always [] here — pool jobs only carry job_skills (SkillDiffService
  // requirements), never the jd_dimensions block (deal_breaker/verdict) that only a pasted-JD match
  // extracts. Asymmetric vs. the gap-report path on purpose (see PR body); revisit if pool jobs ever
  // gain JD-derived dimensions.
  const fit = classifyFit({
    score: recommendation_score,
    required_coverage: diff.required_coverage,
    seniority_verdict: experienceFit.verdict,
    unmet_deal_breakers: [],
    level_gap: policy.level_gap,
    severe_stretch: policy.severe_stretch,
  });
  return {
    job_id: job.id,
    slug: job.slug,
    application_mode: job.application_mode,
    saved: job.saved,
    title: job.title,
    company_name: job.company_name,
    location: job.location,
    ...(sourceName ? { source_name: sourceName } : {}),
    city_codes: jobCityCodes(job),
    locations: buildRecommendationLocations(job),
    role_code: job.role_code,
    experience_level: job.experience_level as ExperienceLevel | null,
    work_mode: job.work_mode ?? null,
    employment_type: job.employment_type ?? null,
    salary_min: job.salary_visible && job.salary_min ? Number(job.salary_min) : null,
    salary_max: job.salary_visible && job.salary_max ? Number(job.salary_max) : null,
    salary_visible: job.salary_visible,
    salary_period: job.salary_period ?? null,
    currency: job.currency,
    source_url: job.application_mode === 'EXTERNAL' ? job.source_url : null,
    posted_at: job.posted_at,
    match_score: diff.overall_score ?? 0,
    recommendation_score,
    severe_stretch: policy.severe_stretch,
    seniority_factor: policy.factor,
    level_gap: policy.level_gap,
    semantic_similarity: semanticSimilarity,
    rank,
    matched_skills: diff.matched_skills.map((s) => s.display_name),
    partial_skills: diff.partial_skills.map((s) => ({
      canonical_name: s.canonical_name,
      display_name: s.display_name,
      importance: s.importance,
      gap_levels: s.gap_levels,
    })),
    missing_skills: diff.missing_skills.map((s) => ({
      display_name: s.display_name,
      importance: s.importance,
    })),
    scoring_breakdown: diff.scoring_breakdown,
    experience_fit: experienceFit,
    fit,
    // R2/R3: verdict unknown ⇒ the policy factor was 1 and seniority contributed nothing — the
    // honest basis is skills_only. Deal-breaker basis is unreachable here by construction (see
    // the unmet_deal_breakers:[] note above).
    score_basis: experienceFit.verdict === 'unknown' ? 'skills_only' : 'skills_and_seniority',
    ...(interview_signals.length > 0 ? { interview_signals } : {}),
  };
}

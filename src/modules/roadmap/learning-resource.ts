import { CatalogCourse } from './course-matcher.service';

export type ResourceSourceType =
  | 'course'
  | 'official_doc'
  | 'video'
  | 'exercise'
  | 'mini_project'
  | 'interview_drill'
  | 'cv_fix_task';
export type ValidationStatus = 'verified' | 'pending' | 'flagged' | 'dead_link';
export type OutcomeType =
  | 'understand'
  | 'practice'
  | 'build_evidence'
  | 'interview_answer'
  | 'cv_improvement';
export type ResourceDifficulty = 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED';
/** The learner's preferred resource language. 'both' = neutral (no language boost). */
export type LanguagePref = 'vi' | 'en' | 'both';
export type WeaknessAddress =
  | 'knowledge'
  | 'evidence'
  | 'communication'
  | 'behavioral'
  | 'role_fit';

export interface ResourceSkill {
  skill_canonical_name: string;
  teaches_level: number;
}

export interface LearningResource {
  id: string;
  source_type: ResourceSourceType;
  title: string;
  provider: string;
  url?: string; // external resources only
  content_template_id?: string; // internal tasks/drills
  is_internal: boolean;
  language: string; // 'vi' | 'en'
  duration_minutes: number;
  difficulty: ResourceDifficulty;
  is_free: boolean;
  skills: ResourceSkill[];
  outcome_type: OutcomeType;
  proof_of_completion?: string;
  addresses?: WeaknessAddress[];
  description?: string; // curated summary — RAG source (future)
  quality_score: number; // 0-100
  freshness_score: number; // 0-100 (stored; offline job recomputes)
  last_verified_at: string; // ISO date
  validation_status: ValidationStatus;
}

/** Map a legacy CatalogCourse → a verified 'course' LearningResource. Lossless: quality = round(rating*20). */
export function mapCourseToLearningResource(
  course: CatalogCourse,
  verifiedAt: string,
): LearningResource {
  return {
    id: course.id,
    source_type: 'course',
    title: course.title,
    provider: course.provider,
    url: course.url,
    is_internal: false,
    language: course.language,
    duration_minutes: course.duration_minutes,
    difficulty: course.difficulty,
    is_free: course.is_free,
    skills: course.skills,
    outcome_type: 'understand',
    quality_score: Math.round(course.rating * 20),
    freshness_score: 100,
    last_verified_at: verifiedAt,
    validation_status: 'verified',
  };
}

/** Merge seed + explicit resources by globally-unique id. Explicit OVERRIDES seed on duplicate id. */
export function mergeResourceCatalogs(
  seed: LearningResource[],
  explicit: LearningResource[],
  onDuplicate?: (id: string) => void,
): LearningResource[] {
  const byId = new Map<string, LearningResource>();
  for (const r of seed) byId.set(r.id, r);
  for (const r of explicit) {
    if (byId.has(r.id) && onDuplicate) onDuplicate(r.id);
    byId.set(r.id, r);
  }
  return [...byId.values()];
}

export interface ResourceMatchRequest {
  skill_canonical_name: string;
  required_level: number;
  weight?: number;
}

export interface ScoredResource extends LearningResource {
  match_score: number; // 0-100
  match_breakdown: {
    quality_pts: number;
    language_pts: number;
    free_pts: number;
    level_fit_pts: number;
    multi_skill_pts: number;
  };
  low_confidence: boolean; // true when this is a 'pending' fallback
}

export interface LearningResourceMatchResult {
  per_skill: Array<{
    skill_canonical_name: string;
    required_level: number;
    resources: ScoredResource[];
  }>;
  uncovered_skills: string[];
}

const TOP_N_PER_SKILL = 3;

/** Deterministic resource score. Mirrors the legacy course formula generalized to quality_score. */
export function scoreResource(
  resource: LearningResource,
  teachesLevel: number,
  req: ResourceMatchRequest,
  requestedSet: Set<string>,
  langPref: LanguagePref = 'both',
): ScoredResource {
  const quality_pts = (resource.quality_score / 100) * 30;
  // Language fit is a PREFERENCE boost, never a filter (never-starve): the user's chosen language gets +20;
  // 'both' is neutral so quality/level decide. Default 'both' — NO baked global VN bias (the platform resolves
  // the user's locale → pref and passes it; un-set callers stay neutral). The course wrapper passes 'vi' for
  // exact legacy parity.
  const language_pts = langPref !== 'both' && resource.language === langPref ? 20 : 0;
  const free_pts = resource.is_free ? 15 : 0;
  const level_fit_pts = teachesLevel >= req.required_level ? 20 : 10;
  const overlap = resource.skills.filter((s) => requestedSet.has(s.skill_canonical_name)).length;
  const coverage = resource.skills.length > 0 ? overlap / Math.max(resource.skills.length, 1) : 0;
  const multi_skill_pts = Math.min(15, coverage * 15);
  const total = quality_pts + language_pts + free_pts + level_fit_pts + multi_skill_pts;
  return {
    ...resource,
    low_confidence: resource.validation_status === 'pending',
    match_score: Math.round(total),
    match_breakdown: {
      quality_pts: Math.round(quality_pts),
      language_pts,
      free_pts,
      level_fit_pts,
      multi_skill_pts: Math.round(multi_skill_pts),
    },
  };
}

/**
 * Deterministic per-skill resource matching. Excludes flagged/dead_link; prefers verified and uses
 * pending only as a fallback (marked low_confidence). `opts.sourceTypes` restricts the catalog first
 * (the course wrapper passes ['course'] for exact legacy parity).
 */
export function matchResources(
  catalog: LearningResource[],
  requests: ResourceMatchRequest[],
  opts?: { sourceTypes?: ResourceSourceType[]; langPref?: LanguagePref },
): LearningResourceMatchResult {
  const allowed = opts?.sourceTypes ? new Set(opts.sourceTypes) : null;
  const langPref: LanguagePref = opts?.langPref ?? 'both';
  const index = new Map<string, Array<{ resource: LearningResource; teaches_level: number }>>();
  for (const r of catalog) {
    if (allowed && !allowed.has(r.source_type)) continue;
    if (r.validation_status === 'flagged' || r.validation_status === 'dead_link') continue;
    for (const s of r.skills ?? []) {
      if (!index.has(s.skill_canonical_name)) index.set(s.skill_canonical_name, []);
      index.get(s.skill_canonical_name)!.push({ resource: r, teaches_level: s.teaches_level });
    }
  }

  const requestedSet = new Set(requests.map((r) => r.skill_canonical_name));
  const per_skill: LearningResourceMatchResult['per_skill'] = [];
  const uncovered_skills: string[] = [];

  for (const req of requests) {
    const candidates = index.get(req.skill_canonical_name) ?? [];
    const verified = candidates.filter((c) => c.resource.validation_status === 'verified');
    const usable = verified.length > 0 ? verified : candidates; // pending only as fallback
    if (usable.length === 0) {
      uncovered_skills.push(req.skill_canonical_name);
      per_skill.push({
        skill_canonical_name: req.skill_canonical_name,
        required_level: req.required_level,
        resources: [],
      });
      continue;
    }
    const scored = usable.map((c) =>
      scoreResource(c.resource, c.teaches_level, req, requestedSet, langPref),
    );
    scored.sort((a, b) => b.match_score - a.match_score);
    per_skill.push({
      skill_canonical_name: req.skill_canonical_name,
      required_level: req.required_level,
      resources: scored.slice(0, TOP_N_PER_SKILL),
    });
  }

  return { per_skill, uncovered_skills };
}

const SOURCE_TYPES = new Set<ResourceSourceType>([
  'course',
  'official_doc',
  'video',
  'exercise',
  'mini_project',
  'interview_drill',
  'cv_fix_task',
]);
const VALIDATION_STATUSES = new Set<ValidationStatus>([
  'verified',
  'pending',
  'flagged',
  'dead_link',
]);
const OUTCOME_TYPES = new Set<OutcomeType>([
  'understand',
  'practice',
  'build_evidence',
  'interview_answer',
  'cv_improvement',
]);
const DIFFICULTIES = new Set<ResourceDifficulty>(['BEGINNER', 'INTERMEDIATE', 'ADVANCED']);
const LANGUAGES = new Set(['vi', 'en']);
const ADDRESSES = new Set<WeaknessAddress>([
  'knowledge',
  'evidence',
  'communication',
  'behavioral',
  'role_fit',
]);

const isNonEmptyStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function coerceSkills(v: unknown): ResourceSkill[] | null {
  if (!Array.isArray(v)) return null;
  const out: ResourceSkill[] = [];
  for (const s of v) {
    if (!s || typeof s !== 'object') return null;
    const o = s as Record<string, unknown>;
    if (!isNonEmptyStr(o.skill_canonical_name) || !isFiniteNum(o.teaches_level)) return null;
    out.push({ skill_canonical_name: o.skill_canonical_name, teaches_level: o.teaches_level });
  }
  return out;
}

/**
 * Validate + coerce the EXPLICIT learning-resource-catalog.json `resources` array (untrusted hand-curated
 * JSON). Drops any entry that isn't a well-formed LearningResource — invalid enum, non-number metric,
 * empty id/title/provider, or malformed skills — calling `onDrop(reason)` so the loader can warn. An
 * invalid explicit resource must NEVER silently match like a real one. Returns [] for non-array input.
 */
export function coerceLearningResources(
  raw: unknown,
  onDrop?: (reason: string) => void,
): LearningResource[] {
  if (!Array.isArray(raw)) return [];
  const drop = (reason: string): void => {
    if (onDrop) onDrop(reason);
  };
  const out: LearningResource[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') {
      drop('explicit resource is not an object');
      continue;
    }
    const o = r as Record<string, unknown>;
    const id = o.id;
    if (!isNonEmptyStr(id)) {
      drop('explicit resource has empty/invalid id');
      continue;
    }
    if (!isNonEmptyStr(o.title) || !isNonEmptyStr(o.provider)) {
      drop(`resource '${id}': empty title/provider`);
      continue;
    }
    if (!isNonEmptyStr(o.source_type) || !SOURCE_TYPES.has(o.source_type as ResourceSourceType)) {
      drop(`resource '${id}': invalid source_type`);
      continue;
    }
    if (
      !isNonEmptyStr(o.validation_status) ||
      !VALIDATION_STATUSES.has(o.validation_status as ValidationStatus)
    ) {
      drop(`resource '${id}': invalid validation_status`);
      continue;
    }
    if (!isNonEmptyStr(o.outcome_type) || !OUTCOME_TYPES.has(o.outcome_type as OutcomeType)) {
      drop(`resource '${id}': invalid outcome_type`);
      continue;
    }
    if (!isNonEmptyStr(o.difficulty) || !DIFFICULTIES.has(o.difficulty as ResourceDifficulty)) {
      drop(`resource '${id}': invalid difficulty`);
      continue;
    }
    if (
      !isFiniteNum(o.duration_minutes) ||
      !isFiniteNum(o.quality_score) ||
      !isFiniteNum(o.freshness_score)
    ) {
      drop(`resource '${id}': invalid number field`);
      continue;
    }
    if (
      typeof o.is_internal !== 'boolean' ||
      typeof o.is_free !== 'boolean' ||
      !isNonEmptyStr(o.language) ||
      !LANGUAGES.has(o.language)
    ) {
      drop(`resource '${id}': invalid is_internal/is_free/language`);
      continue;
    }
    if (!isNonEmptyStr(o.last_verified_at)) {
      drop(`resource '${id}': invalid last_verified_at`);
      continue;
    }
    const skills = coerceSkills(o.skills);
    if (!skills) {
      drop(`resource '${id}': invalid skills array`);
      continue;
    }
    out.push({
      id,
      source_type: o.source_type as ResourceSourceType,
      title: o.title,
      provider: o.provider,
      url: typeof o.url === 'string' ? o.url : undefined,
      content_template_id:
        typeof o.content_template_id === 'string' ? o.content_template_id : undefined,
      is_internal: o.is_internal,
      language: o.language,
      duration_minutes: o.duration_minutes,
      difficulty: o.difficulty as ResourceDifficulty,
      is_free: o.is_free,
      skills,
      outcome_type: o.outcome_type as OutcomeType,
      proof_of_completion:
        typeof o.proof_of_completion === 'string' ? o.proof_of_completion : undefined,
      addresses: Array.isArray(o.addresses)
        ? o.addresses.filter((a): a is WeaknessAddress => ADDRESSES.has(a as WeaknessAddress))
        : undefined,
      description: typeof o.description === 'string' ? o.description : undefined,
      quality_score: o.quality_score,
      freshness_score: o.freshness_score,
      last_verified_at: o.last_verified_at,
      validation_status: o.validation_status as ValidationStatus,
    });
  }
  return out;
}

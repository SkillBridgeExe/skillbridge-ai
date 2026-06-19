import type { CatalogCourse } from './course-matcher.service';

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
  url?: string;
  content_template_id?: string;
  is_internal: boolean;
  language: string;
  duration_minutes: number;
  difficulty: ResourceDifficulty;
  is_free: boolean;
  skills: ResourceSkill[];
  outcome_type: OutcomeType;
  proof_of_completion?: string;
  addresses?: WeaknessAddress[];
  description?: string;
  quality_score: number;
  freshness_score: number;
  last_verified_at: string;
  validation_status: ValidationStatus;
}

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

export function mergeResourceCatalogs(
  seed: LearningResource[],
  explicit: LearningResource[],
  onDuplicate?: (id: string) => void,
): LearningResource[] {
  const byId = new Map<string, LearningResource>();
  for (const resource of seed) {
    byId.set(resource.id, resource);
  }
  for (const resource of explicit) {
    if (byId.has(resource.id)) {
      onDuplicate?.(resource.id);
    }
    byId.set(resource.id, resource);
  }
  return [...byId.values()];
}

export interface ResourceMatchRequest {
  skill_canonical_name: string;
  required_level: number;
  weight?: number;
}

export interface ScoredResource extends LearningResource {
  match_score: number;
  match_breakdown: {
    quality_pts: number;
    language_pts: number;
    free_pts: number;
    level_fit_pts: number;
    multi_skill_pts: number;
  };
  low_confidence: boolean;
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

export function scoreResource(
  resource: LearningResource,
  teachesLevel: number,
  req: ResourceMatchRequest,
  requestedSet: Set<string>,
): ScoredResource {
  const quality_pts = (resource.quality_score / 100) * 30;
  const language_pts = resource.language === 'vi' ? 20 : 0;
  const free_pts = resource.is_free ? 15 : 0;
  const level_fit_pts = teachesLevel >= req.required_level ? 20 : 10;
  const overlap = resource.skills.filter((skill) =>
    requestedSet.has(skill.skill_canonical_name),
  ).length;
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

export function matchResources(
  catalog: LearningResource[],
  requests: ResourceMatchRequest[],
  opts?: { sourceTypes?: ResourceSourceType[] },
): LearningResourceMatchResult {
  const allowed = opts?.sourceTypes ? new Set(opts.sourceTypes) : null;
  const index = new Map<string, Array<{ resource: LearningResource; teaches_level: number }>>();

  for (const resource of catalog) {
    if (allowed && !allowed.has(resource.source_type)) continue;
    if (resource.validation_status === 'flagged' || resource.validation_status === 'dead_link') {
      continue;
    }

    for (const skill of resource.skills ?? []) {
      if (!index.has(skill.skill_canonical_name)) {
        index.set(skill.skill_canonical_name, []);
      }
      index.get(skill.skill_canonical_name)!.push({
        resource,
        teaches_level: skill.teaches_level,
      });
    }
  }

  const requestedSet = new Set(requests.map((request) => request.skill_canonical_name));
  const per_skill: LearningResourceMatchResult['per_skill'] = [];
  const uncovered_skills: string[] = [];

  for (const req of requests) {
    const candidates = index.get(req.skill_canonical_name) ?? [];
    const verified = candidates.filter(
      (candidate) => candidate.resource.validation_status === 'verified',
    );
    const usable = verified.length > 0 ? verified : candidates;

    if (usable.length === 0) {
      uncovered_skills.push(req.skill_canonical_name);
      per_skill.push({
        skill_canonical_name: req.skill_canonical_name,
        required_level: req.required_level,
        resources: [],
      });
      continue;
    }

    const scored = usable.map((candidate) =>
      scoreResource(candidate.resource, candidate.teaches_level, req, requestedSet),
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

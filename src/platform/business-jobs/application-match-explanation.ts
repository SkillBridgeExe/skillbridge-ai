export type ApplicationMatchStatus = 'PENDING' | 'READY' | 'FAILED';

export interface ApplicationMatchSource {
  matchStatus: ApplicationMatchStatus;
  matchScore: string | number | null;
  matchScoringVersion: string | null;
  matchErrorCode: string | null;
  matchResult: unknown;
}

export interface ApplicationMatchSkill {
  canonicalName: string;
  displayName: string;
  importance: string | null;
  cvLevel: number | null;
  requiredLevel: number | null;
}

export interface ApplicationMatchExplanation {
  status: ApplicationMatchStatus;
  score: number | null;
  scoringVersion: string | null;
  scoreBasis: string | null;
  requirementsSource: string | null;
  requiredCoverage: number | null;
  errorCode: string | null;
  matchedSkills: ApplicationMatchSkill[];
  partialSkills: ApplicationMatchSkill[];
  missingSkills: ApplicationMatchSkill[];
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeSkill(value: unknown): ApplicationMatchSkill | null {
  const skill = asRecord(value);
  if (!skill) return null;

  const canonicalName = asString(skill.canonical_name);
  const displayName = asString(skill.display_name);
  if (!canonicalName || !displayName) return null;

  return {
    canonicalName,
    displayName,
    importance: asString(skill.importance),
    cvLevel: asFiniteNumber(skill.cv_level),
    requiredLevel: asFiniteNumber(skill.required_level),
  };
}

function normalizeSkills(value: unknown): ApplicationMatchSkill[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(normalizeSkill)
    .filter((skill): skill is ApplicationMatchSkill => skill !== null);
}

export function buildApplicationMatchExplanation(
  source: ApplicationMatchSource,
): ApplicationMatchExplanation {
  const result = asRecord(source.matchResult);

  return {
    status: source.matchStatus,
    score: asFiniteNumber(source.matchScore),
    scoringVersion: source.matchScoringVersion,
    scoreBasis: asString(result?.score_basis),
    requirementsSource: asString(result?.requirements_source),
    requiredCoverage: asFiniteNumber(result?.required_coverage),
    errorCode: source.matchErrorCode,
    matchedSkills: normalizeSkills(result?.matched_skills),
    partialSkills: normalizeSkills(result?.partial_skills),
    missingSkills: normalizeSkills(result?.missing_skills),
  };
}

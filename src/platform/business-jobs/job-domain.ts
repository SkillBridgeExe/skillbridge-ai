import { BadRequestException } from '@nestjs/common';
import { ConflictException } from '@nestjs/common';
import type { JobApplicationStatus } from '../../database/entities/job-application.entity';
import {
  buildApplicationMatchExplanation,
  type ApplicationMatchStatus,
} from './application-match-explanation';

export type { JobApplicationStatus } from '../../database/entities/job-application.entity';

export const BUSINESS_JOB_ROLE_CODES = [
  'frontend_developer',
  'backend_developer',
  'fullstack_developer',
  'data_analyst',
  'mobile_developer',
  'devops_engineer',
  'qa_tester',
  'ai_ml_engineer',
  'ai_app_engineer',
] as const;

const APPLICATION_TRANSITIONS: Record<JobApplicationStatus, JobApplicationStatus[]> = {
  SUBMITTED: ['IN_REVIEW', 'REJECTED', 'WITHDRAWN'],
  IN_REVIEW: ['SHORTLISTED', 'REJECTED', 'WITHDRAWN'],
  SHORTLISTED: ['REJECTED', 'WITHDRAWN'],
  REJECTED: [],
  WITHDRAWN: [],
};

export function assertApplicationTransition(
  from: JobApplicationStatus,
  to: JobApplicationStatus,
): void {
  if (!APPLICATION_TRANSITIONS[from].includes(to)) {
    throw new BadRequestException({
      errorCode: 'INVALID_APPLICATION_STATUS_TRANSITION',
      message: `Cannot transition application from ${from} to ${to}`,
    });
  }
}

export function assertPublishDeadline(deadline: Date, now = new Date()): void {
  const max = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(deadline.getTime()) || deadline <= now || deadline > max) {
    throw new BadRequestException({
      errorCode: 'VALIDATION_ERROR',
      message: 'Application deadline must be in the future and no more than 60 days away',
    });
  }
}

export function assertExpectedRevision(expected: number, actual: number): void {
  if (expected !== actual) {
    throw new ConflictException({
      errorCode: 'JOB_VERSION_CONFLICT',
      message: 'Job draft was changed by another request',
    });
  }
}

export interface PublishReadinessBlocker {
  code: 'BUSINESS_NOT_VERIFIED' | 'JOB_SKILLS_NOT_CONFIRMED' | 'VALIDATION_ERROR';
  field: string;
  message: string;
}

export interface PublishReadiness {
  ready: boolean;
  blockers: PublishReadinessBlocker[];
}

export interface PublishReadinessInput {
  companyStatus?: string | null;
  title?: string | null;
  roleCode?: string | null;
  summary?: string | null;
  responsibilities?: unknown[] | null;
  requirements?: unknown[] | null;
  locations?: unknown[] | null;
  skills?: unknown[] | null;
  skillsConfirmedAt?: Date | string | null;
  applicationDeadline?: Date | string | null;
  salaryMin?: string | number | null;
  salaryMax?: string | number | null;
  minYearsExperience?: string | number | null;
  maxYearsExperience?: string | number | null;
}

export function evaluateJobPublishReadiness(
  input: PublishReadinessInput,
  now = new Date(),
): PublishReadiness {
  const blockers: PublishReadinessBlocker[] = [];
  const invalid = (field: string, message: string) =>
    blockers.push({ code: 'VALIDATION_ERROR', field, message });

  if (input.companyStatus !== undefined && input.companyStatus !== 'VERIFIED') {
    blockers.push({
      code: 'BUSINESS_NOT_VERIFIED',
      field: 'companyStatus',
      message: 'Verified company is required to publish jobs',
    });
  }
  if (!input.title?.trim()) invalid('title', 'title is required');
  if (!input.roleCode || !(BUSINESS_JOB_ROLE_CODES as readonly string[]).includes(input.roleCode)) {
    invalid('roleCode', 'A valid roleCode is required');
  }
  if (!input.summary?.trim()) invalid('summary', 'summary is required');
  if (!hasNonEmptyText(input.responsibilities)) {
    invalid('responsibilities', 'At least one responsibility is required');
  }
  if (!hasNonEmptyText(input.requirements)) {
    invalid('requirements', 'At least one requirement is required');
  }
  if (!hasValidLocations(input.locations)) {
    invalid(
      'locations',
      'At least one location with a city and two-character country code is required',
    );
  }

  const deadline = asDate(input.applicationDeadline);
  const maxDeadline = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);
  if (!deadline || deadline <= now || deadline > maxDeadline) {
    invalid(
      'applicationDeadline',
      'Application deadline must be in the future and no more than 60 days away',
    );
  }
  if (!input.skills?.length) invalid('skills', 'At least one skill is required');
  if (!asDate(input.skillsConfirmedAt)) {
    blockers.push({
      code: 'JOB_SKILLS_NOT_CONFIRMED',
      field: 'skillsConfirmedAt',
      message: 'Job skills must be confirmed before publishing',
    });
  }
  if (isInvalidRange(input.salaryMin, input.salaryMax)) {
    invalid('salaryMin', 'salaryMin must not exceed salaryMax');
  }
  if (isInvalidRange(input.minYearsExperience, input.maxYearsExperience)) {
    invalid('minYearsExperience', 'minYearsExperience must not exceed maxYearsExperience');
  }

  return { ready: blockers.length === 0, blockers };
}

export function assertPublishableDraft(input: {
  title?: string | null;
  roleCode?: string | null;
  summary?: string | null;
  responsibilities?: unknown[];
  requirements?: unknown[];
  locations?: unknown[];
  skills?: unknown[];
  skillsConfirmedAt?: Date | null;
}): void {
  const relevantFields = new Set([
    'title',
    'roleCode',
    'summary',
    'responsibilities',
    'requirements',
    'locations',
    'skills',
    'skillsConfirmedAt',
  ]);
  const blocker = evaluateJobPublishReadiness(input).blockers.find((item) =>
    relevantFields.has(item.field),
  );
  if (blocker) {
    throw new BadRequestException({
      errorCode: blocker.code,
      message: blocker.message,
    });
  }
}

function hasNonEmptyText(items: unknown[] | null | undefined): boolean {
  return !!items?.some((item) => typeof item === 'string' && item.trim());
}

function hasValidLocations(locations: unknown[] | null | undefined): boolean {
  return (
    !!locations?.length &&
    locations.every((location) => {
      if (!location || typeof location !== 'object') return false;
      const value = location as { cityCode?: unknown; countryCode?: unknown };
      return (
        typeof value.cityCode === 'string' &&
        !!value.cityCode.trim() &&
        typeof value.countryCode === 'string' &&
        value.countryCode.trim().length === 2
      );
    })
  );
}

function asDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isInvalidRange(
  min: string | number | null | undefined,
  max: string | number | null | undefined,
): boolean {
  if (min === null || min === undefined || max === null || max === undefined) return false;
  const numericMin = Number(min);
  const numericMax = Number(max);
  return !Number.isFinite(numericMin) || !Number.isFinite(numericMax) || numericMin > numericMax;
}

export function assertApplyableJob(
  job: {
    status: string;
    applicationMode: string;
    currentPublishedVersionId: string | null;
    expiresAt: Date | null;
  },
  requestedVersionId: string,
  now = new Date(),
): void {
  if (
    job.status !== 'active' ||
    job.applicationMode !== 'NATIVE' ||
    !job.expiresAt ||
    job.expiresAt <= now
  ) {
    throw new ConflictException({
      errorCode: 'JOB_NOT_ACTIVE',
      message: 'Job is not accepting native applications',
    });
  }
  if (job.currentPublishedVersionId !== requestedVersionId) {
    throw new ConflictException({
      errorCode: 'JOB_VERSION_CHANGED',
      message: 'Job changed after it was viewed; review the latest version before applying',
    });
  }
}

export function isPubliclyVisibleJob(
  job: {
    status: string;
    applicationMode: string;
    canonicalJobId: string | null;
    expiresAt: Date | null;
  },
  companyVerified: boolean,
  now = new Date(),
): boolean {
  return (
    job.status === 'active' &&
    job.canonicalJobId === null &&
    (!job.expiresAt || job.expiresAt > now) &&
    (job.applicationMode === 'EXTERNAL' || companyVerified)
  );
}

export interface SalaryInput {
  visible: boolean;
  min: number | null;
  max: number | null;
  currency: string;
  period: 'MONTH' | 'YEAR' | null;
  negotiable: boolean;
}

export function publicSalary(input: SalaryInput): SalaryInput {
  return {
    ...input,
    min: input.visible ? input.min : null,
    max: input.visible ? input.max : null,
  };
}

export function retentionDateForApplication(input: {
  status: JobApplicationStatus;
  terminalAt: Date | null;
  jobEndedAt: Date | null;
}): Date {
  const terminalStatus = input.status === 'REJECTED' || input.status === 'WITHDRAWN';
  const anchor = terminalStatus ? input.terminalAt : input.jobEndedAt;
  if (!anchor) {
    throw new BadRequestException({
      errorCode: 'VALIDATION_ERROR',
      message: 'A terminal or job end timestamp is required to schedule PII purge',
    });
  }
  const purgeAt = new Date(anchor);
  purgeAt.setUTCDate(purgeAt.getUTCDate() + 90);
  return purgeAt;
}

export function proficiencyHintForLevel(
  level: number | null,
): 'BEGINNER' | 'NOVICE' | 'INTERMEDIATE' | 'ADVANCED' | 'EXPERT' | undefined {
  if (!level) return undefined;
  return ['BEGINNER', 'NOVICE', 'INTERMEDIATE', 'ADVANCED', 'EXPERT'][
    Math.min(Math.max(Math.trunc(level), 1), 5) - 1
  ] as 'BEGINNER' | 'NOVICE' | 'INTERMEDIATE' | 'ADVANCED' | 'EXPERT';
}

export function safeApplication<
  T extends {
    cvStorageObjectKey?: unknown;
    cvChecksumSha256?: unknown;
    matchStatus?: ApplicationMatchStatus;
    matchScore?: string | number | null;
    matchScoringVersion?: string | null;
    matchErrorCode?: string | null;
    matchResult?: unknown;
  },
>(application: T) {
  const { cvStorageObjectKey: _storageKey, cvChecksumSha256: _checksum, ...safe } = application;
  return {
    ...safe,
    matchExplanation: buildApplicationMatchExplanation({
      matchStatus: application.matchStatus ?? 'PENDING',
      matchScore: application.matchScore ?? null,
      matchScoringVersion: application.matchScoringVersion ?? null,
      matchErrorCode: application.matchErrorCode ?? null,
      matchResult: application.matchResult,
    }),
  };
}

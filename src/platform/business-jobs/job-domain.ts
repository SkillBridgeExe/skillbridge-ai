import { BadRequestException } from '@nestjs/common';
import { ConflictException } from '@nestjs/common';
import type { JobApplicationStatus } from '../../database/entities/job-application.entity';

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
  if (
    !input.title?.trim() ||
    !input.roleCode ||
    !(BUSINESS_JOB_ROLE_CODES as readonly string[]).includes(input.roleCode) ||
    !input.summary?.trim() ||
    !input.responsibilities?.length ||
    !input.requirements?.length ||
    !input.locations?.length ||
    !input.skills?.length ||
    !input.skillsConfirmedAt
  ) {
    throw new BadRequestException({
      errorCode:
        input.skills?.length && !input.skillsConfirmedAt
          ? 'JOB_SKILLS_NOT_CONFIRMED'
          : 'VALIDATION_ERROR',
      message: 'Job draft is incomplete or its skills have not been confirmed',
    });
  }
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
  T extends { cvStorageObjectKey?: unknown; cvChecksumSha256?: unknown },
>(application: T) {
  const { cvStorageObjectKey: _storageKey, cvChecksumSha256: _checksum, ...safe } = application;
  return safe;
}

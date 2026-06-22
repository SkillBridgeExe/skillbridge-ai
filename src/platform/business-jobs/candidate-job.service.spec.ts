import { ObjectLiteral, Repository } from 'typeorm';
import { CvEntity } from '../../database/entities/cv.entity';
import { CvSkillEntity } from '../../database/entities/cv-skill.entity';
import { JobApplicationStatusEventEntity } from '../../database/entities/job-application-status-event.entity';
import { JobApplicationEntity } from '../../database/entities/job-application.entity';
import { JobPostVersionEntity } from '../../database/entities/job-post-version.entity';
import { JobReportEntity } from '../../database/entities/job-report.entity';
import { JobEntity } from '../../database/entities/job.entity';
import { SavedJobEntity } from '../../database/entities/saved-job.entity';
import { SkillEntity } from '../../database/entities/skill.entity';
import { UserEntity } from '../../database/entities/user.entity';
import {
  CandidateJobService,
  safeSavedJob,
  snapshotCandidateContact,
} from './candidate-job.service';
import { safeApplication } from './job-domain';

function repo<T extends ObjectLiteral>() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    findAndCount: jest.fn(),
    create: jest.fn((value) => value),
    save: jest.fn(async (value) => value),
    delete: jest.fn(),
    insert: jest.fn(),
  } as unknown as jest.Mocked<Repository<T>>;
}

describe('CandidateJobService', () => {
  it('does not expose hidden salary or internal crawler fields from saved jobs', () => {
    const safe = safeSavedJob({
      id: 'job-1',
      slug: 'backend',
      title: 'Backend',
      salaryVisible: false,
      salaryMin: '100',
      salaryMax: '200',
      salaryNegotiable: true,
      currency: 'VND',
      salaryPeriod: 'MONTH',
      applicationMode: 'EXTERNAL',
      sourceUrl: 'https://source.test/job',
      contentHash: 'internal',
    } as unknown as JobEntity);
    expect(safe.salary).toEqual(expect.objectContaining({ min: null, max: null }));
    expect(safe).not.toHaveProperty('contentHash');
  });

  it.each([
    ['closed', new Date('2026-12-01T00:00:00.000Z')],
    ['active', new Date('2025-12-01T00:00:00.000Z')],
  ] as const)('does not mark a %s saved job as applyable', (status, expiresAt) => {
    const safe = safeSavedJob({
      id: 'job-1',
      slug: 'backend',
      title: 'Backend',
      status,
      expiresAt,
      applicationMode: 'NATIVE',
      currentPublishedVersionId: 'version-1',
      salaryVisible: false,
      salaryNegotiable: false,
      locationCityCodes: [],
    } as unknown as JobEntity);

    expect(safe.canApply).toBe(false);
  });

  it('does not mark a saved native job applyable after company verification is reset', () => {
    const job = {
      id: 'job-1',
      slug: 'backend',
      title: 'Backend',
      status: 'active',
      expiresAt: new Date('2099-12-01T00:00:00.000Z'),
      canonicalJobId: null,
      applicationMode: 'NATIVE',
      currentPublishedVersionId: 'version-1',
      salaryVisible: false,
      salaryNegotiable: false,
      locationCityCodes: [],
    } as unknown as JobEntity;

    const safe = (
      safeSavedJob as unknown as (
        value: JobEntity,
        companyVerified: boolean,
      ) => { canApply: boolean }
    )(job, false);

    expect(safe.canApply).toBe(false);
  });

  it('uses authenticated account identity for the application contact snapshot', () => {
    const user = {
      fullName: 'Account Name',
      email: 'User@Example.com',
      emailNormalized: 'user@example.com',
    } as UserEntity;
    expect(
      snapshotCandidateContact(user, {
        candidateName: 'Frontend Name',
        candidateEmail: 'user@example.com',
        candidatePhone: '0900000000',
      }),
    ).toEqual({ name: 'Account Name', email: 'user@example.com', phone: '0900000000' });
    expect(() =>
      snapshotCandidateContact(user, {
        candidateName: 'Frontend Name',
        candidateEmail: 'attacker@example.com',
      }),
    ).toThrow();
    try {
      snapshotCandidateContact(user, {
        candidateName: 'Frontend Name',
        candidateEmail: 'attacker@example.com',
      });
    } catch (error) {
      expect(error).toMatchObject({
        response: expect.objectContaining({
          message: 'Candidate email must match the authenticated account',
        }),
      });
    }
  });

  it('does not expose private CV object keys in application JSON', () => {
    const safe = safeApplication({
      id: 'application-1',
      status: 'SUBMITTED',
      cvStorageObjectKey: 'private/key.pdf',
      cvChecksumSha256: 'secret-checksum',
    } as JobApplicationEntity);
    expect(safe).not.toHaveProperty('cvStorageObjectKey');
    expect(safe).not.toHaveProperty('cvChecksumSha256');
    expect(safe).toEqual(expect.objectContaining({ id: 'application-1', status: 'SUBMITTED' }));
  });

  it('does not allow saving a non-public draft job by UUID', async () => {
    const jobs = repo<JobEntity>();
    jobs.findOne.mockResolvedValue({
      id: 'job-1',
      status: 'draft',
      applicationMode: 'EXTERNAL',
    } as JobEntity);
    const savedJobs = repo<SavedJobEntity>();
    const service = new CandidateJobService(
      jobs,
      repo<JobPostVersionEntity>(),
      savedJobs,
      repo<JobApplicationEntity>(),
      repo<JobApplicationStatusEventEntity>(),
      repo<JobReportEntity>(),
      repo<CvEntity>(),
      repo<CvSkillEntity>(),
      repo<SkillEntity>(),
      repo<UserEntity>(),
      {} as never,
      {} as never,
      {} as never,
      { query: jest.fn() } as never,
      { processNotificationEvent: jest.fn() } as never,
    );

    await expect(service.saveJob('user-1', 'job-1')).rejects.toMatchObject({
      status: 404,
      response: expect.objectContaining({ errorCode: 'JOB_NOT_FOUND' }),
    });
    expect(savedJobs.save).not.toHaveBeenCalled();
  });

  it('withdraws an owned application and schedules PII purge 90 days later', async () => {
    const applications = repo<JobApplicationEntity>();
    const events = repo<JobApplicationStatusEventEntity>();
    const terminalAt = new Date('2026-01-01T00:00:00.000Z');
    applications.findOne.mockResolvedValue({
      id: 'application-1',
      candidateUserId: 'user-1',
      status: 'IN_REVIEW',
      terminalAt: null,
    } as JobApplicationEntity);
    const manager = {
      getRepository: jest.fn((target) => (target === JobApplicationEntity ? applications : events)),
    };
    const service = new CandidateJobService(
      repo<JobEntity>(),
      repo<JobPostVersionEntity>(),
      repo<SavedJobEntity>(),
      applications,
      events,
      repo<JobReportEntity>(),
      repo<CvEntity>(),
      repo<CvSkillEntity>(),
      repo<SkillEntity>(),
      repo<UserEntity>(),
      {} as never,
      {} as never,
      {} as never,
      { transaction: jest.fn(async (work) => work(manager)) } as never,
      { processNotificationEvent: jest.fn() } as never,
    );

    jest.useFakeTimers().setSystemTime(terminalAt);
    const result = await service.withdraw('user-1', 'application-1');
    jest.useRealTimers();

    expect(result.status).toBe('WITHDRAWN');
    expect(result.piiPurgeAfter?.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(events.save).toHaveBeenCalledWith(
      expect.objectContaining({
        fromStatus: 'IN_REVIEW',
        toStatus: 'WITHDRAWN',
        notificationStatus: 'NOT_REQUIRED',
      }),
    );
  });
});

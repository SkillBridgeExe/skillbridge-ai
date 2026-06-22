import { ObjectLiteral, Repository } from 'typeorm';
import { BusinessProfileEntity } from '../../database/entities/business-profile.entity';
import { JobApplicationStatusEventEntity } from '../../database/entities/job-application-status-event.entity';
import { JobApplicationEntity } from '../../database/entities/job-application.entity';
import { JobEntity } from '../../database/entities/job.entity';
import { BusinessJobsMaintenanceService } from './business-jobs-maintenance.service';

function repo<T extends ObjectLiteral>() {
  return {
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(async (value) => value),
  } as unknown as jest.Mocked<Repository<T>>;
}

describe('BusinessJobsMaintenanceService', () => {
  it('expires due employer jobs before retention scheduling', async () => {
    const dataSource = { query: jest.fn().mockResolvedValue([{ id: 'job-1' }]) };
    const service = new BusinessJobsMaintenanceService(
      repo<JobApplicationStatusEventEntity>(),
      repo<JobApplicationEntity>(),
      repo<JobEntity>(),
      repo<BusinessProfileEntity>(),
      { sendTransactionalEmail: jest.fn() } as never,
      { delete: jest.fn() } as never,
      dataSource as never,
    );
    expect(await service.expireDueEmployerJobs(new Date('2026-01-01'))).toBe(1);
    expect(dataSource.query).toHaveBeenCalledWith(expect.stringContaining("status = 'expired'"), [
      '2026-01-01T00:00:00.000Z',
    ]);
  });

  it('marks a notification sent only after email delivery succeeds', async () => {
    const events = repo<JobApplicationStatusEventEntity>();
    const applications = repo<JobApplicationEntity>();
    events.find.mockResolvedValue([
      {
        id: 'event-1',
        applicationId: 'application-1',
        toStatus: 'IN_REVIEW',
        notificationType: 'APPLICATION_STATUS_CHANGED',
        notificationStatus: 'PENDING',
        notificationAttemptCount: 0,
      } as JobApplicationStatusEventEntity,
    ]);
    applications.findOne.mockResolvedValue({
      id: 'application-1',
      candidateEmail: 'candidate@example.com',
      status: 'SHORTLISTED',
    } as JobApplicationEntity);
    const email = { sendTransactionalEmail: jest.fn().mockResolvedValue(undefined) };
    const service = new BusinessJobsMaintenanceService(
      events,
      applications,
      repo<JobEntity>(),
      repo<BusinessProfileEntity>(),
      email as never,
      { delete: jest.fn() } as never,
      { query: jest.fn().mockResolvedValue([{ id: 'event-1' }]) } as never,
    );

    expect(await service.processPendingNotifications()).toBe(1);
    expect(email.sendTransactionalEmail).toHaveBeenCalledWith(
      'candidate@example.com',
      expect.stringContaining('IN_REVIEW'),
      expect.any(String),
      expect.any(String),
    );
    expect(events.save).toHaveBeenCalledWith(
      expect.objectContaining({ notificationStatus: 'SENT' }),
    );
  });

  it('purges due PII and the private CV object without deleting the application', async () => {
    const applications = repo<JobApplicationEntity>();
    applications.find.mockResolvedValue([
      {
        id: 'application-1',
        candidateName: 'Candidate',
        candidateEmail: 'candidate@example.com',
        candidatePhone: '0900',
        coverNote: 'Hello',
        cvStorageObjectKey: 'job-applications/a/cv.pdf',
        cvSkillsSnapshot: [{ canonicalName: 'nodejs' }],
        piiPurgeAfter: new Date('2026-01-01'),
        piiPurgedAt: null,
      } as unknown as JobApplicationEntity,
    ]);
    const storage = { delete: jest.fn().mockResolvedValue(undefined) };
    const service = new BusinessJobsMaintenanceService(
      repo<JobApplicationStatusEventEntity>(),
      applications,
      repo<JobEntity>(),
      repo<BusinessProfileEntity>(),
      { sendTransactionalEmail: jest.fn() } as never,
      storage as never,
      { query: jest.fn() } as never,
    );

    expect(await service.purgeDueApplicationPii(new Date('2026-02-01'))).toBe(1);
    expect(storage.delete).toHaveBeenCalledWith('job-applications/a/cv.pdf');
    expect(applications.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'application-1',
        candidateName: '[purged]',
        candidateEmail: '[purged]',
        candidatePhone: null,
        coverNote: null,
        cvStorageObjectKey: null,
        cvSkillsSnapshot: [],
      }),
    );
  });

  it('keeps PII metadata for retry when deleting the private CV fails', async () => {
    const applications = repo<JobApplicationEntity>();
    applications.find.mockResolvedValue([
      {
        id: 'application-1',
        candidateName: 'Candidate',
        candidateEmail: 'candidate@example.com',
        cvStorageObjectKey: 'job-applications/a/cv.pdf',
        cvSkillsSnapshot: [],
        piiPurgeAfter: new Date('2026-01-01'),
        piiPurgedAt: null,
      } as unknown as JobApplicationEntity,
    ]);
    const service = new BusinessJobsMaintenanceService(
      repo<JobApplicationStatusEventEntity>(),
      applications,
      repo<JobEntity>(),
      repo<BusinessProfileEntity>(),
      { sendTransactionalEmail: jest.fn() } as never,
      { delete: jest.fn().mockRejectedValue(new Error('gcs unavailable')) } as never,
      { query: jest.fn() } as never,
    );

    expect(await service.purgeDueApplicationPii(new Date('2026-02-01'))).toBe(0);
    expect(applications.save).not.toHaveBeenCalled();
  });

  it('sends an event at most once when immediate processors race', async () => {
    const events = repo<JobApplicationStatusEventEntity>();
    const applications = repo<JobApplicationEntity>();
    const event = {
      id: 'event-1',
      applicationId: 'application-1',
      toStatus: 'IN_REVIEW',
      notificationType: 'APPLICATION_STATUS_CHANGED',
      notificationStatus: 'PENDING',
      notificationAttemptCount: 0,
      notificationNextAttemptAt: new Date('2026-01-01'),
    } as JobApplicationStatusEventEntity;
    events.findOne.mockResolvedValue(event);
    applications.findOne.mockResolvedValue({
      id: 'application-1',
      candidateEmail: 'candidate@example.com',
      status: 'IN_REVIEW',
    } as JobApplicationEntity);
    const email = { sendTransactionalEmail: jest.fn().mockResolvedValue(undefined) };
    const dataSource = {
      query: jest
        .fn()
        .mockResolvedValueOnce([{ id: 'event-1' }])
        .mockResolvedValueOnce([]),
    };
    const service = new BusinessJobsMaintenanceService(
      events,
      applications,
      repo<JobEntity>(),
      repo<BusinessProfileEntity>(),
      email as never,
      { delete: jest.fn() } as never,
      dataSource as never,
    );

    await Promise.all([
      service.processNotificationEvent('event-1', new Date('2026-01-01')),
      service.processNotificationEvent('event-1', new Date('2026-01-01')),
    ]);

    expect(email.sendTransactionalEmail).toHaveBeenCalledTimes(1);
  });
});

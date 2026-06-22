import { ObjectLiteral, Repository } from 'typeorm';
import { BusinessProfileEntity } from '../../database/entities/business-profile.entity';
import { JobApplicationStatusEventEntity } from '../../database/entities/job-application-status-event.entity';
import { JobApplicationEntity } from '../../database/entities/job-application.entity';
import { JobEntity } from '../../database/entities/job.entity';
import { BusinessApplicationService } from './business-application.service';

function repo<T extends ObjectLiteral>() {
  return {
    findOne: jest.fn(),
    findAndCount: jest.fn(),
    create: jest.fn((value) => value),
    save: jest.fn(async (value) => value),
  } as unknown as jest.Mocked<Repository<T>>;
}

describe('BusinessApplicationService', () => {
  it('rejects an owned application and queues the candidate status email atomically', async () => {
    const applications = repo<JobApplicationEntity>();
    const events = repo<JobApplicationStatusEventEntity>();
    const jobs = repo<JobEntity>();
    const profiles = repo<BusinessProfileEntity>();
    profiles.findOne.mockResolvedValue({
      userId: 'business-1',
      companyId: 'company-1',
    } as BusinessProfileEntity);
    jobs.findOne.mockResolvedValue({
      id: 'job-1',
      companyId: 'company-1',
      sourceType: 'employer',
    } as JobEntity);
    applications.findOne.mockResolvedValue({
      id: 'application-1',
      jobId: 'job-1',
      status: 'IN_REVIEW',
      terminalAt: null,
    } as JobApplicationEntity);
    const manager = {
      getRepository: jest.fn((target) => (target === JobApplicationEntity ? applications : events)),
    };
    const service = new BusinessApplicationService(
      applications,
      events,
      jobs,
      profiles,
      {} as never,
      { transaction: jest.fn(async (work) => work(manager)) } as never,
      { processNotificationEvent: jest.fn() } as never,
    );
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const result = await service.updateStatus('business-1', 'application-1', {
      expectedStatus: 'IN_REVIEW',
      status: 'REJECTED',
      internalNote: 'Role filled',
    });
    jest.useRealTimers();

    expect(result.status).toBe('REJECTED');
    expect(result.piiPurgeAfter?.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(events.save).toHaveBeenCalledWith(
      expect.objectContaining({
        notificationType: 'APPLICATION_STATUS_CHANGED',
        notificationStatus: 'PENDING',
      }),
    );
  });
});

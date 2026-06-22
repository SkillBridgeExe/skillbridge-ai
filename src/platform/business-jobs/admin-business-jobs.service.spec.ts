import { ObjectLiteral, Repository } from 'typeorm';
import { BusinessProfileEntity } from '../../database/entities/business-profile.entity';
import { JobReportEntity } from '../../database/entities/job-report.entity';
import { JobEntity } from '../../database/entities/job.entity';
import { AdminBusinessJobsService } from './admin-business-jobs.service';

function repo<T extends ObjectLiteral>() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    findAndCount: jest.fn(),
    save: jest.fn(async (value) => value),
  } as unknown as jest.Mocked<Repository<T>>;
}

describe('AdminBusinessJobsService', () => {
  it('removes all active employer jobs when a company is suspended', async () => {
    const profiles = repo<BusinessProfileEntity>();
    const jobs = repo<JobEntity>();
    profiles.findOne.mockResolvedValue({
      id: 'profile-1',
      companyId: 'company-1',
      status: 'VERIFIED',
    } as BusinessProfileEntity);
    jobs.find.mockResolvedValue([
      {
        id: 'job-1',
        companyId: 'company-1',
        sourceType: 'employer',
        status: 'active',
      } as JobEntity,
      {
        id: 'job-2',
        companyId: 'company-1',
        sourceType: 'employer',
        status: 'active',
      } as JobEntity,
    ]);
    const manager = {
      getRepository: jest.fn((target) => (target === BusinessProfileEntity ? profiles : jobs)),
    };
    const service = new AdminBusinessJobsService(jobs, repo<JobReportEntity>(), {
      transaction: jest.fn(async (work) => work(manager)),
    } as never);

    await service.updateBusinessStatus('admin-1', 'profile-1', 'SUSPENDED', 'Fraud review');

    expect(jobs.save).toHaveBeenCalledTimes(1);
    const removed = jobs.save.mock.calls[0][0] as unknown as JobEntity[];
    expect(removed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'job-1', status: 'removed', removalReason: 'Fraud review' }),
        expect.objectContaining({ id: 'job-2', status: 'removed', removalReason: 'Fraud review' }),
      ]),
    );
  });
});

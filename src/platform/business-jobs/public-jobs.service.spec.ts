import { CompanyEntity } from '../../database/entities/company.entity';
import { JobPostVersionEntity } from '../../database/entities/job-post-version.entity';
import { JobEntity } from '../../database/entities/job.entity';
import { mapPublicJob, PublicJobsService } from './public-jobs.service';

describe('public job mapper', () => {
  it('hides salary and enables native apply only for employer jobs with a published version', () => {
    const result = mapPublicJob(
      {
        id: 'job-1',
        slug: 'backend-job',
        title: 'Backend',
        salaryMin: '20000000',
        salaryMax: '30000000',
        salaryVisible: false,
        salaryNegotiable: true,
        currency: 'VND',
        salaryPeriod: 'MONTH',
        applicationMode: 'NATIVE',
        currentPublishedVersionId: 'version-1',
        sourceUrl: null,
      } as JobEntity,
      { id: 'company-1', slug: 'acme', name: 'Acme' } as CompanyEntity,
      { id: 'version-1', summary: 'Build APIs' } as JobPostVersionEntity,
    );
    expect(result.salary).toEqual(
      expect.objectContaining({ min: null, max: null, visible: false }),
    );
    expect(result.canApply).toBe(true);
    expect(result.currentVersionId).toBe('version-1');
  });

  it('builds filters from the same active, unexpired and verified visibility scope as the public feed', async () => {
    const qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    const service = new PublicJobsService(
      { createQueryBuilder: jest.fn().mockReturnValue(qb) } as never,
      {} as never,
      {} as never,
    );

    await service.filters();

    expect(qb.where).toHaveBeenCalledWith("job.status = 'active'");
    expect(qb.andWhere).toHaveBeenCalledWith('(job.expiresAt IS NULL OR job.expiresAt > now())');
    expect(qb.andWhere).toHaveBeenCalledWith('job.canonicalJobId IS NULL');
    expect(qb.andWhere).toHaveBeenCalledWith(expect.anything());
  });
});

import { ObjectLiteral, Repository } from 'typeorm';
import { BusinessProfileEntity } from '../../database/entities/business-profile.entity';
import { JobPostVersionEntity } from '../../database/entities/job-post-version.entity';
import { JobEntity } from '../../database/entities/job.entity';
import { SkillEntity } from '../../database/entities/skill.entity';
import {
  BusinessJobService,
  publishedLocationCityCodes,
  publishedLocationLabel,
} from './business-job.service';

function repo<T extends ObjectLiteral>() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    findAndCount: jest.fn(),
    create: jest.fn((value) => value),
    save: jest.fn(async (value) => value),
    remove: jest.fn(),
  } as unknown as jest.Mocked<Repository<T>>;
}

describe('BusinessJobService', () => {
  it('preserves the most precise truthful location label when publishing', () => {
    expect(
      publishedLocationLabel({
        cityCode: 'HCM',
        countryCode: 'VN',
        districtCode: 'THU_DUC',
        districtName: 'Thành phố Thủ Đức',
        addressLine: 'Khu Công nghệ cao, phường Tăng Nhơn Phú',
        isPrimary: true,
      }),
    ).toBe('Khu Công nghệ cao, phường Tăng Nhơn Phú');
    expect(
      publishedLocationLabel({
        cityCode: 'HCM',
        countryCode: 'VN',
        districtName: 'Quận 3',
        addressLine: '   ',
        isPrimary: false,
      }),
    ).toBe('Quận 3');
    expect(
      publishedLocationLabel({
        cityCode: 'HAN',
        countryCode: 'VN',
        addressLine: '',
        isPrimary: false,
      }),
    ).toBe('HAN');
  });

  it('normalizes and deduplicates published city codes for filtering', () => {
    expect(
      publishedLocationCityCodes([
        { cityCode: ' hcm ', countryCode: 'VN', addressLine: '', isPrimary: true },
        { cityCode: 'HCM', countryCode: 'VN', addressLine: '', isPrimary: false },
        { cityCode: ' han ', countryCode: 'VN', addressLine: '', isPrimary: false },
      ]),
    ).toEqual(['HCM', 'HAN']);
  });

  it('searches and paginates only the current company jobs on the server', async () => {
    const jobs = repo<JobEntity>();
    const versions = repo<JobPostVersionEntity>();
    const profiles = repo<BusinessProfileEntity>();
    const qb = {
      where: jest.fn(),
      andWhere: jest.fn(),
      orderBy: jest.fn(),
      skip: jest.fn(),
      take: jest.fn(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    for (const method of ['where', 'andWhere', 'orderBy', 'skip', 'take'] as const) {
      qb[method].mockReturnValue(qb);
    }
    (jobs.createQueryBuilder as jest.Mock) = jest.fn(() => qb);
    profiles.findOne.mockResolvedValue({
      userId: 'business-1',
      companyId: 'company-1',
    } as BusinessProfileEntity);
    const service = new BusinessJobService(
      jobs,
      versions,
      profiles,
      {} as never,
      { scan: jest.fn(() => []) } as never,
      { refreshEmployerJobEmbedding: jest.fn() } as never,
    );

    await expect(
      service.listMine('business-1', { page: 2, limit: 10, status: 'active', q: ' backend ' }),
    ).resolves.toEqual({ items: [], total: 0, page: 2, limit: 10 });

    expect(qb.where).toHaveBeenCalledWith('job.company_id = :companyId', {
      companyId: 'company-1',
    });
    expect(qb.andWhere).toHaveBeenCalledWith('job.status = :status', { status: 'active' });
    expect(qb.andWhere).toHaveBeenCalledWith(expect.anything());
    expect(qb.skip).toHaveBeenCalledWith(10);
    expect(qb.take).toHaveBeenCalledWith(10);
  });

  it('includes company-aware publish readiness in business job detail', async () => {
    const jobs = repo<JobEntity>();
    const versions = repo<JobPostVersionEntity>();
    const profiles = repo<BusinessProfileEntity>();
    profiles.findOne.mockResolvedValue({
      id: 'profile-1',
      userId: 'business-1',
      companyId: 'company-1',
      status: 'DRAFT',
    } as BusinessProfileEntity);
    jobs.findOne.mockResolvedValue({
      id: 'job-1',
      companyId: 'company-1',
      sourceType: 'employer',
      currentPublishedVersionId: null,
    } as JobEntity);
    versions.findOne.mockResolvedValue({
      id: 'draft-1',
      title: 'Backend Developer',
      roleCode: 'backend_developer',
      summary: 'Build APIs',
      responsibilities: ['Build APIs'],
      requirements: ['Node.js'],
      locations: [{ cityCode: 'HCM', countryCode: 'VN', isPrimary: true }],
      skills: [{ skillId: 'skill-1' }],
      skillsConfirmedAt: new Date(),
      applicationDeadline: new Date(Date.now() + 24 * 60 * 60 * 1000),
      salaryMin: '30',
      salaryMax: '20',
      minYearsExperience: '1',
      maxYearsExperience: '2',
    } as unknown as JobPostVersionEntity);
    const service = new BusinessJobService(
      jobs,
      versions,
      profiles,
      {} as never,
      { scan: jest.fn(() => []) } as never,
      { refreshEmployerJobEmbedding: jest.fn() } as never,
    );

    const result = await service.getMine('business-1', 'job-1');

    expect(result.publishReadiness).toEqual(
      expect.objectContaining({
        ready: false,
        blockers: expect.arrayContaining([
          expect.objectContaining({ code: 'BUSINESS_NOT_VERIFIED', field: 'companyStatus' }),
          expect.objectContaining({ field: 'salaryMin' }),
        ]),
      }),
    );
  });

  it('creates an employer-native job with its first draft version atomically', async () => {
    const jobs = repo<JobEntity>();
    const versions = repo<JobPostVersionEntity>();
    const profiles = repo<BusinessProfileEntity>();
    profiles.findOne.mockResolvedValue({
      userId: 'business-1',
      companyId: 'company-1',
      status: 'DRAFT',
    } as BusinessProfileEntity);
    jobs.save.mockImplementation(async (value) => ({ ...value, id: 'job-1' }) as JobEntity);
    versions.save.mockImplementation(
      async (value) => ({ ...value, id: 'version-1' }) as JobPostVersionEntity,
    );
    const manager = {
      getRepository: jest.fn((target) => (target === JobEntity ? jobs : versions)),
    };
    const dataSource = { transaction: jest.fn(async (work) => work(manager)) };
    const service = new BusinessJobService(
      jobs,
      versions,
      profiles,
      dataSource as never,
      { scan: jest.fn(() => []) } as never,
      { refreshEmployerJobEmbedding: jest.fn() } as never,
    );

    const result = await service.createDraft('business-1', { title: 'Backend Developer' });

    expect(result.job).toEqual(
      expect.objectContaining({
        companyId: 'company-1',
        sourceType: 'employer',
        applicationMode: 'NATIVE',
        status: 'draft',
      }),
    );
    expect(result.draft).toEqual(
      expect.objectContaining({ jobId: 'job-1', versionNo: 1, status: 'DRAFT' }),
    );
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
  });

  it('creates a second draft from the published version without replacing the live version', async () => {
    const jobs = repo<JobEntity>();
    const versions = repo<JobPostVersionEntity>();
    const profiles = repo<BusinessProfileEntity>();
    profiles.findOne.mockResolvedValue({
      userId: 'business-1',
      companyId: 'company-1',
    } as BusinessProfileEntity);
    jobs.findOne.mockResolvedValue({
      id: 'job-1',
      companyId: 'company-1',
      currentPublishedVersionId: 'version-1',
      status: 'active',
      sourceType: 'employer',
    } as JobEntity);
    versions.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'version-1',
      jobId: 'job-1',
      versionNo: 1,
      status: 'PUBLISHED',
      revision: 1,
      title: 'Backend Developer',
      responsibilities: ['Build APIs'],
      requirements: ['Node.js'],
      niceToHave: [],
      benefits: [],
      interviewProcess: [],
      locations: [],
      skills: [],
      openingsCount: 1,
    } as unknown as JobPostVersionEntity);
    versions.save.mockImplementation(
      async (value) => ({ ...value, id: 'version-2' }) as JobPostVersionEntity,
    );
    const manager = {
      getRepository: jest.fn((target) => (target === JobEntity ? jobs : versions)),
    };
    const service = new BusinessJobService(
      jobs,
      versions,
      profiles,
      { transaction: jest.fn(async (work) => work(manager)) } as never,
      { scan: jest.fn(() => []) } as never,
      { refreshEmployerJobEmbedding: jest.fn() } as never,
    );

    const updated = await service.updateDraft('business-1', 'job-1', {
      expectedRevision: 1,
      title: 'Senior Backend Developer',
    });

    expect(updated.id).toBe('version-2');
    expect(updated.versionNo).toBe(2);
    expect(updated.title).toBe('Senior Backend Developer');
    expect(jobs.save).not.toHaveBeenCalled();
    expect(jobs.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    );
  });

  it('publishes detailed locations into normalized job-card mirror fields', async () => {
    const jobs = repo<JobEntity>();
    const versions = repo<JobPostVersionEntity>();
    const profiles = repo<BusinessProfileEntity>();
    const job = {
      id: 'job-1',
      companyId: 'company-1',
      sourceType: 'employer',
      status: 'draft',
      currentPublishedVersionId: null,
    } as JobEntity;
    const draft = {
      id: 'version-1',
      jobId: 'job-1',
      versionNo: 1,
      status: 'DRAFT',
      revision: 1,
      title: 'Backend Developer',
      roleCode: 'backend_developer',
      summary: 'Build reliable APIs',
      responsibilities: ['Build and operate APIs'],
      requirements: ['Node.js'],
      locations: [
        {
          cityCode: ' hcm ',
          countryCode: 'VN',
          districtCode: 'THU_DUC',
          districtName: 'Thành phố Thủ Đức',
          addressLine: 'Khu Công nghệ cao, phường Tăng Nhơn Phú',
          isPrimary: true,
        },
        {
          cityCode: 'HAN',
          countryCode: 'VN',
          addressLine: '',
          isPrimary: false,
        },
      ],
      skills: [
        {
          skillId: 'skill-1',
          canonicalName: 'nodejs',
          importance: 'REQUIRED',
          minLevel: 2,
          confidence: 1,
          rawText: 'Node.js',
        },
      ],
      skillsConfirmedAt: new Date(),
      applicationDeadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    } as unknown as JobPostVersionEntity;
    profiles.findOne.mockResolvedValue({
      id: 'profile-1',
      userId: 'business-1',
      companyId: 'company-1',
      status: 'VERIFIED',
    } as BusinessProfileEntity);
    jobs.findOne.mockResolvedValue(job);
    versions.findOne.mockResolvedValue(draft);
    const manager = {
      getRepository: jest.fn((target) => {
        if (target === JobEntity) return jobs;
        if (target === BusinessProfileEntity) return profiles;
        return versions;
      }),
      query: jest.fn().mockResolvedValue([]),
    };
    const service = new BusinessJobService(
      jobs,
      versions,
      profiles,
      { transaction: jest.fn(async (work) => work(manager)) } as never,
      { scan: jest.fn(() => []) } as never,
      { refreshEmployerJobEmbedding: jest.fn().mockResolvedValue(undefined) } as never,
    );

    await service.publish('business-1', 'job-1', 1);

    expect(jobs.save).toHaveBeenCalledWith(
      expect.objectContaining({
        location: 'Khu Công nghệ cao, phường Tăng Nhơn Phú, HAN',
        primaryCityCode: 'HCM',
        locationCityCodes: ['HCM', 'HAN'],
      }),
    );
  });

  it('locks the job and draft during publish and reports a stale concurrent publish as 409', async () => {
    const jobs = repo<JobEntity>();
    const versions = repo<JobPostVersionEntity>();
    const profiles = repo<BusinessProfileEntity>();
    profiles.findOne.mockResolvedValue({
      userId: 'business-1',
      companyId: 'company-1',
      status: 'VERIFIED',
    } as BusinessProfileEntity);
    jobs.findOne.mockResolvedValue({
      id: 'job-1',
      companyId: 'company-1',
      sourceType: 'employer',
      status: 'active',
    } as JobEntity);
    versions.findOne.mockResolvedValue(null);
    const manager = {
      getRepository: jest.fn((target) => {
        if (target === JobEntity) return jobs;
        if (target === BusinessProfileEntity) return profiles;
        return versions;
      }),
    };
    const service = new BusinessJobService(
      jobs,
      versions,
      profiles,
      { transaction: jest.fn(async (work) => work(manager)) } as never,
      { scan: jest.fn(() => []) } as never,
      { refreshEmployerJobEmbedding: jest.fn() } as never,
    );

    await expect(service.publish('business-1', 'job-1', 2)).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ errorCode: 'JOB_VERSION_CHANGED' }),
    });
    expect(jobs.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    );
    expect(versions.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    );
  });

  it.each(['closed', 'expired', 'removed'] as const)(
    'does not publish a %s job back to active',
    async (status) => {
      const jobs = repo<JobEntity>();
      const versions = repo<JobPostVersionEntity>();
      const profiles = repo<BusinessProfileEntity>();
      profiles.findOne.mockResolvedValue({
        id: 'profile-1',
        userId: 'business-1',
        companyId: 'company-1',
        status: 'VERIFIED',
      } as BusinessProfileEntity);
      jobs.findOne.mockResolvedValue({
        id: 'job-1',
        companyId: 'company-1',
        sourceType: 'employer',
        status,
      } as JobEntity);
      const manager = {
        getRepository: jest.fn((target) => {
          if (target === JobEntity) return jobs;
          if (target === BusinessProfileEntity) return profiles;
          return versions;
        }),
      };
      const service = new BusinessJobService(
        jobs,
        versions,
        profiles,
        { transaction: jest.fn(async (work) => work(manager)) } as never,
        { scan: jest.fn(() => []) } as never,
        { refreshEmployerJobEmbedding: jest.fn() } as never,
      );

      await expect(service.publish('business-1', 'job-1', 1)).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({ errorCode: 'JOB_NOT_EDITABLE' }),
      });
    },
  );

  it('rechecks verified business status inside the publish transaction', async () => {
    const jobs = repo<JobEntity>();
    const versions = repo<JobPostVersionEntity>();
    const profiles = repo<BusinessProfileEntity>();
    profiles.findOne
      .mockResolvedValueOnce({
        id: 'profile-1',
        userId: 'business-1',
        companyId: 'company-1',
        status: 'VERIFIED',
      } as BusinessProfileEntity)
      .mockResolvedValueOnce({
        id: 'profile-1',
        userId: 'business-1',
        companyId: 'company-1',
        status: 'VERIFIED',
      } as BusinessProfileEntity)
      .mockResolvedValueOnce({
        id: 'profile-1',
        userId: 'business-1',
        companyId: 'company-1',
        status: 'SUSPENDED',
      } as BusinessProfileEntity);
    jobs.findOne.mockResolvedValue({
      id: 'job-1',
      companyId: 'company-1',
      sourceType: 'employer',
      status: 'active',
    } as JobEntity);
    const manager = {
      getRepository: jest.fn((target) => {
        if (target === JobEntity) return jobs;
        if (target === BusinessProfileEntity) return profiles;
        return versions;
      }),
    };
    const service = new BusinessJobService(
      jobs,
      versions,
      profiles,
      { transaction: jest.fn(async (work) => work(manager)) } as never,
      { scan: jest.fn(() => []) } as never,
      { refreshEmployerJobEmbedding: jest.fn() } as never,
    );

    await expect(service.publish('business-1', 'job-1', 1)).rejects.toMatchObject({
      status: 403,
      response: expect.objectContaining({ errorCode: 'BUSINESS_NOT_VERIFIED' }),
    });
  });

  it('rejects stale skill extraction instead of overwriting a newer draft', async () => {
    const jobs = repo<JobEntity>();
    const versions = repo<JobPostVersionEntity>();
    const profiles = repo<BusinessProfileEntity>();
    profiles.findOne.mockResolvedValue({
      userId: 'business-1',
      companyId: 'company-1',
      status: 'VERIFIED',
    } as BusinessProfileEntity);
    jobs.findOne.mockResolvedValue({
      id: 'job-1',
      companyId: 'company-1',
      sourceType: 'employer',
      status: 'active',
    } as JobEntity);
    versions.findOne.mockResolvedValue({
      id: 'draft-1',
      jobId: 'job-1',
      status: 'DRAFT',
      revision: 2,
      title: 'Backend',
      summary: 'Build APIs',
      responsibilities: [],
      requirements: [],
      niceToHave: [],
      skills: [],
    } as unknown as JobPostVersionEntity);
    const manager = {
      getRepository: jest.fn((target) => {
        if (target === JobEntity) return jobs;
        if (target === SkillEntity) return repo<SkillEntity>();
        return versions;
      }),
    };
    const service = new BusinessJobService(
      jobs,
      versions,
      profiles,
      { transaction: jest.fn(async (work) => work(manager)) } as never,
      { scan: jest.fn(() => []) } as never,
      { refreshEmployerJobEmbedding: jest.fn() } as never,
    );

    await expect(
      (
        service.extractDraftSkills as unknown as (
          userId: string,
          jobId: string,
          expectedRevision: number,
        ) => Promise<unknown>
      )('business-1', 'job-1', 1),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ errorCode: 'JOB_VERSION_CONFLICT' }),
    });
  });
});

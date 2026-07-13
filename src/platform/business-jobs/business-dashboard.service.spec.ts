import { ObjectLiteral, Repository } from 'typeorm';
import { BusinessProfileEntity } from '../../database/entities/business-profile.entity';
import { CompanyEntity } from '../../database/entities/company.entity';
import { JobApplicationEntity } from '../../database/entities/job-application.entity';
import { JobEntity } from '../../database/entities/job.entity';
import { BusinessDashboardService } from './business-dashboard.service';

function repo<T extends ObjectLiteral>() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    count: jest.fn(),
  } as unknown as jest.Mocked<Repository<T>>;
}

describe('BusinessDashboardService', () => {
  it('returns a real company snapshot, aggregate metrics, and recent applications', async () => {
    const profiles = repo<BusinessProfileEntity>();
    const companies = repo<CompanyEntity>();
    const jobs = repo<JobEntity>();
    const applications = repo<JobApplicationEntity>();
    profiles.findOne.mockResolvedValue({
      id: 'profile-1',
      userId: 'business-1',
      companyId: 'company-1',
      status: 'VERIFIED',
      contactName: 'Linh',
      workEmailDomain: 'acme.vn',
      workEmailVerifiedAt: new Date(),
    } as BusinessProfileEntity);
    companies.findOne.mockResolvedValue({
      id: 'company-1',
      name: 'Acme',
      slug: 'acme',
      website: 'https://acme.vn',
      industryCode: 'TECH',
      shortDescription: 'Builds useful products',
      logoObjectKey: 'companies/acme/logo.png',
    } as CompanyEntity);
    jobs.find.mockResolvedValue([
      { id: 'job-1', title: 'Frontend Engineer', slug: 'frontend', status: 'active' },
      { id: 'job-2', title: 'QA Engineer', slug: 'qa', status: 'closed' },
    ] as JobEntity[]);
    applications.count
      .mockResolvedValueOnce(8)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1);
    applications.find.mockResolvedValue([
      {
        id: 'application-1',
        jobId: 'job-1',
        candidateName: 'An Nguyen',
        status: 'IN_REVIEW',
        submittedAt: new Date('2026-07-01T00:00:00.000Z'),
        matchStatus: 'READY',
        matchScore: '88.00',
        matchScoringVersion: 'skill-diff-v2',
        matchErrorCode: null,
        matchResult: { score_basis: 'skills_only' },
      },
    ] as JobApplicationEntity[]);

    const result = await new BusinessDashboardService(
      profiles,
      companies,
      jobs,
      applications,
    ).getDashboard('business-1');

    expect(result.company).toEqual(
      expect.objectContaining({
        name: 'Acme',
        status: 'VERIFIED',
        publishAllowed: true,
        blockers: [],
        logoUrl: '/api/business/company/logo',
      }),
    );
    expect(result.metrics).toEqual({
      activeJobs: 1,
      totalApplications: 8,
      submitted: 3,
      inReview: 2,
      shortlisted: 1,
    });
    expect(result.recentApplications[0]).toEqual(
      expect.objectContaining({
        id: 'application-1',
        job: { id: 'job-1', title: 'Frontend Engineer', slug: 'frontend', status: 'active' },
        matchExplanation: expect.objectContaining({ status: 'READY', score: 88 }),
      }),
    );
  });

  it('returns an honest empty snapshot when the business has no profile yet', async () => {
    const profiles = repo<BusinessProfileEntity>();
    profiles.findOne.mockResolvedValue(null);
    const result = await new BusinessDashboardService(
      profiles,
      repo<CompanyEntity>(),
      repo<JobEntity>(),
      repo<JobApplicationEntity>(),
    ).getDashboard('new-business');

    expect(result).toEqual({
      company: null,
      metrics: {
        activeJobs: 0,
        totalApplications: 0,
        submitted: 0,
        inReview: 0,
        shortlisted: 0,
      },
      recentApplications: [],
    });
  });
});

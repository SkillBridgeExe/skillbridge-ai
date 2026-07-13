import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { BusinessProfileEntity } from '../../database/entities/business-profile.entity';
import { CompanyEntity } from '../../database/entities/company.entity';
import { JobApplicationEntity } from '../../database/entities/job-application.entity';
import { JobEntity } from '../../database/entities/job.entity';
import { businessProfileBlockers, canPublishJobs } from './business-profile-readiness';
import { safeApplication } from './job-domain';

const EMPTY_METRICS = {
  activeJobs: 0,
  totalApplications: 0,
  submitted: 0,
  inReview: 0,
  shortlisted: 0,
} as const;

@Injectable()
export class BusinessDashboardService {
  constructor(
    @InjectRepository(BusinessProfileEntity)
    private readonly profiles: Repository<BusinessProfileEntity>,
    @InjectRepository(CompanyEntity)
    private readonly companies: Repository<CompanyEntity>,
    @InjectRepository(JobEntity)
    private readonly jobs: Repository<JobEntity>,
    @InjectRepository(JobApplicationEntity)
    private readonly applications: Repository<JobApplicationEntity>,
  ) {}

  async getDashboard(userId: string) {
    const profile = await this.profiles.findOne({ where: { userId } });
    if (!profile) {
      return { company: null, metrics: { ...EMPTY_METRICS }, recentApplications: [] };
    }

    const company = await this.companies.findOne({ where: { id: profile.companyId } });
    if (!company) {
      return { company: null, metrics: { ...EMPTY_METRICS }, recentApplications: [] };
    }

    const jobs = await this.jobs.find({
      where: { companyId: company.id, sourceType: 'employer' },
      select: { id: true, title: true, slug: true, status: true },
    });
    const jobIds = jobs.map((job) => job.id);
    const baseWhere = { jobId: In(jobIds) };
    const [totalApplications, submitted, inReview, shortlisted, recentApplications] = jobIds.length
      ? await Promise.all([
          this.applications.count({ where: baseWhere }),
          this.applications.count({ where: { ...baseWhere, status: 'SUBMITTED' } }),
          this.applications.count({ where: { ...baseWhere, status: 'IN_REVIEW' } }),
          this.applications.count({ where: { ...baseWhere, status: 'SHORTLISTED' } }),
          this.applications.find({
            where: baseWhere,
            order: { submittedAt: 'DESC' },
            take: 5,
          }),
        ])
      : [0, 0, 0, 0, [] as JobApplicationEntity[]];
    const jobById = new Map(jobs.map((job) => [job.id, job]));

    return {
      company: {
        profileId: profile.id,
        companyId: company.id,
        name: company.name,
        slug: company.slug,
        logoUrl: company.logoObjectKey ? '/api/business/company/logo' : null,
        status: profile.status,
        publishAllowed: canPublishJobs(profile.status),
        blockers: businessProfileBlockers(profile, company),
      },
      metrics: {
        activeJobs: jobs.filter((job) => job.status === 'active').length,
        totalApplications,
        submitted,
        inReview,
        shortlisted,
      },
      recentApplications: recentApplications.map((application) => ({
        ...safeApplication(application),
        job: jobById.get(application.jobId) ?? null,
      })),
    };
  }
}

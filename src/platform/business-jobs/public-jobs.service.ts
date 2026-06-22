import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository } from 'typeorm';
import { CompanyEntity } from '../../database/entities/company.entity';
import { JobPostVersionEntity } from '../../database/entities/job-post-version.entity';
import { JobEntity } from '../../database/entities/job.entity';
import { PublicJobsQueryDto } from './dto/business-jobs.dto';
import { publicSalary } from './job-domain';

@Injectable()
export class PublicJobsService {
  constructor(
    @InjectRepository(JobEntity) private readonly jobs: Repository<JobEntity>,
    @InjectRepository(CompanyEntity) private readonly companies: Repository<CompanyEntity>,
    @InjectRepository(JobPostVersionEntity)
    private readonly versions: Repository<JobPostVersionEntity>,
  ) {}

  async list(query: PublicJobsQueryDto) {
    const page = Math.max(query.page, 1);
    const limit = Math.min(Math.max(query.limit, 1), 100);
    const qb = this.activeVisibleQuery();
    if (query.q?.trim()) {
      qb.andWhere(
        `(
          job.title ILIKE :search OR EXISTS (
            SELECT 1 FROM public.companies c WHERE c.id = job.company_id AND c.name ILIKE :search
          )
        )`,
        { search: `%${query.q.trim()}%` },
      );
    }
    if (query.roleCodes?.length)
      qb.andWhere('job.roleCode IN (:...roleCodes)', { roleCodes: query.roleCodes });
    if (query.cityCodes?.length)
      qb.andWhere('job.locationCityCodes && :cityCodes', { cityCodes: query.cityCodes });
    if (query.workModes?.length)
      qb.andWhere('job.workMode IN (:...workModes)', { workModes: query.workModes });
    if (query.employmentTypes?.length)
      qb.andWhere('job.employmentType IN (:...employmentTypes)', {
        employmentTypes: query.employmentTypes,
      });
    if (query.experienceLevels?.length)
      qb.andWhere('job.experienceLevel IN (:...experienceLevels)', {
        experienceLevels: query.experienceLevels,
      });
    if (query.skillIds?.length) {
      qb.andWhere(
        'EXISTS (SELECT 1 FROM public.job_skills js WHERE js.job_id = job.id AND js.skill_id = ANY(:skillIds))',
        { skillIds: query.skillIds },
      );
    }
    if (query.salaryMin !== undefined) {
      qb.andWhere('job.salaryVisible = true AND job.salaryMax >= :salaryMin', {
        salaryMin: query.salaryMin,
      });
    }
    if (query.source !== 'ALL')
      qb.andWhere('job.applicationMode = :source', { source: query.source });
    if (query.companySlug) {
      qb.andWhere(
        'EXISTS (SELECT 1 FROM public.companies c WHERE c.id = job.company_id AND c.slug = :companySlug)',
        { companySlug: query.companySlug },
      );
    }
    if (query.sort === 'SALARY_DESC') qb.orderBy('job.salaryMax', 'DESC', 'NULLS LAST');
    else if (query.sort === 'RELEVANCE' && query.q?.trim()) {
      qb.orderBy('CASE WHEN job.title ILIKE :prefix THEN 0 ELSE 1 END', 'ASC').addOrderBy(
        'job.postedAt',
        'DESC',
      );
      qb.setParameter('prefix', `${query.q.trim()}%`);
    } else qb.orderBy('job.postedAt', 'DESC', 'NULLS LAST');
    qb.addOrderBy('job.id', 'ASC')
      .skip((page - 1) * limit)
      .take(limit);
    const [items, total] = await qb.getManyAndCount();
    return { items: await this.hydrate(items), total, page, limit };
  }

  async filters() {
    const jobs = await this.activeVisibleQuery()
      .orderBy('job.postedAt', 'DESC', 'NULLS LAST')
      .getMany();
    return {
      roleCodes: countValues(jobs.flatMap((job) => (job.roleCode ? [job.roleCode] : []))),
      cityCodes: countValues(jobs.flatMap((job) => job.locationCityCodes)),
      workModes: countValues(jobs.flatMap((job) => (job.workMode ? [job.workMode] : []))),
      employmentTypes: countValues(
        jobs.flatMap((job) => (job.employmentType ? [job.employmentType] : [])),
      ),
      experienceLevels: countValues(
        jobs.flatMap((job) => (job.experienceLevel ? [job.experienceLevel] : [])),
      ),
    };
  }

  async detail(slug: string) {
    const job = await this.jobs.findOne({ where: { slug, status: 'active' } });
    if (!job || (job.expiresAt && job.expiresAt <= new Date())) throw this.notFound();
    const company = await this.companies.findOne({ where: { id: job.companyId } });
    if (!company) throw this.notFound();
    if (job.applicationMode === 'NATIVE') {
      const verified = await this.companies.manager.query(
        `SELECT 1 FROM public.business_profiles WHERE company_id = $1 AND status = 'VERIFIED' LIMIT 1`,
        [company.id],
      );
      if (!verified.length) throw this.notFound();
    }
    const version = job.currentPublishedVersionId
      ? await this.versions.findOne({ where: { id: job.currentPublishedVersionId } })
      : null;
    return mapPublicJob(job, company, version);
  }

  async listCompany(slug: string, query: PublicJobsQueryDto) {
    return this.list({ ...query, companySlug: slug });
  }

  private activeVisibleQuery() {
    return this.jobs
      .createQueryBuilder('job')
      .where("job.status = 'active'")
      .andWhere('(job.expiresAt IS NULL OR job.expiresAt > now())')
      .andWhere('job.canonicalJobId IS NULL')
      .andWhere(
        new Brackets((visibility) => {
          visibility.where("job.applicationMode = 'EXTERNAL'").orWhere(
            `EXISTS (
                 SELECT 1 FROM public.business_profiles bp
                  WHERE bp.company_id = job.company_id AND bp.status = 'VERIFIED'
               )`,
          );
        }),
      );
  }

  private async hydrate(jobs: JobEntity[]) {
    if (!jobs.length) return [];
    const [companies, versions] = await Promise.all([
      this.companies.find({ where: { id: In([...new Set(jobs.map((job) => job.companyId))]) } }),
      this.versions.find({
        where: {
          id: In(
            jobs.flatMap((job) =>
              job.currentPublishedVersionId ? [job.currentPublishedVersionId] : [],
            ),
          ),
        },
      }),
    ]);
    const companyById = new Map(companies.map((company) => [company.id, company]));
    const versionById = new Map(versions.map((version) => [version.id, version]));
    return jobs.flatMap((job) => {
      const company = companyById.get(job.companyId);
      if (!company) return [];
      return [
        mapPublicJob(
          job,
          company,
          job.currentPublishedVersionId
            ? (versionById.get(job.currentPublishedVersionId) ?? null)
            : null,
        ),
      ];
    });
  }

  private notFound() {
    return new NotFoundException({ errorCode: 'JOB_NOT_FOUND', message: 'Job not found' });
  }
}

export function mapPublicJob(
  job: JobEntity,
  company: CompanyEntity,
  version: JobPostVersionEntity | null,
) {
  return {
    id: job.id,
    slug: job.slug,
    title: job.title,
    roleCode: job.roleCode,
    company: {
      id: company.id,
      slug: company.slug,
      name: company.name,
      logoUrl: company.logoObjectKey ? `/api/companies/${company.slug}/logo` : null,
    },
    location: job.location,
    cityCodes: job.locationCityCodes,
    workMode: job.workMode,
    employmentType: job.employmentType,
    experienceLevel: job.experienceLevel,
    openingsCount: job.openingsCount,
    salary: publicSalary({
      visible: job.salaryVisible,
      min: job.salaryMin === null ? null : Number(job.salaryMin),
      max: job.salaryMax === null ? null : Number(job.salaryMax),
      currency: job.currency,
      period: job.salaryPeriod,
      negotiable: job.salaryNegotiable,
    }),
    applicationMode: job.applicationMode,
    canApply: job.applicationMode === 'NATIVE' && Boolean(version),
    sourceUrl: job.applicationMode === 'EXTERNAL' ? job.sourceUrl : null,
    currentVersionId: job.applicationMode === 'NATIVE' ? (version?.id ?? null) : null,
    postedAt: job.postedAt,
    expiresAt: job.expiresAt,
    content: version
      ? {
          summary: version.summary,
          responsibilities: version.responsibilities,
          requirements: version.requirements,
          niceToHave: version.niceToHave,
          benefits: version.benefits,
          interviewProcess: version.interviewProcess,
          workingTime: version.workingTime,
          locations: version.locations,
          educationLevel: version.educationLevel,
          languageCode: version.languageCode,
        }
      : null,
  };
}

function countValues(values: string[]) {
  const counts = new Map<string, number>();
  values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([value, count]) => ({ value, count }));
}

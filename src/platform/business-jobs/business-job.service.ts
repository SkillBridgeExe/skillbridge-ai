import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { DataSource, In, Repository } from 'typeorm';
import { SkillTextScannerService } from '../../common/services/skill-text-scanner.service';
import { BusinessProfileEntity } from '../../database/entities/business-profile.entity';
import {
  JobLocationSnapshot,
  JobPostVersionEntity,
  JobSkillSnapshot,
} from '../../database/entities/job-post-version.entity';
import { JobEntity } from '../../database/entities/job.entity';
import { SkillEntity } from '../../database/entities/skill.entity';
import { JdIngestService } from '../../modules/jobs/ingest/jd-ingest.service';
import {
  assertExpectedRevision,
  assertPublishableDraft,
  assertPublishDeadline,
} from './job-domain';

export interface JobDraftInput {
  expectedRevision?: number;
  title?: string;
  roleCode?: string | null;
  employmentType?: string | null;
  experienceLevel?: string | null;
  minYearsExperience?: number | null;
  maxYearsExperience?: number | null;
  workMode?: 'ONSITE' | 'HYBRID' | 'REMOTE' | null;
  openingsCount?: number;
  salaryMin?: number | null;
  salaryMax?: number | null;
  currency?: string;
  salaryPeriod?: 'MONTH' | 'YEAR' | null;
  salaryVisible?: boolean;
  salaryNegotiable?: boolean;
  educationLevel?: string | null;
  languageCode?: string | null;
  applicationDeadline?: string | Date | null;
  summary?: string | null;
  responsibilities?: string[];
  requirements?: string[];
  niceToHave?: string[];
  benefits?: string[];
  interviewProcess?: string[];
  workingTime?: string | null;
  locations?: JobLocationSnapshot[];
}

@Injectable()
export class BusinessJobService {
  constructor(
    @InjectRepository(JobEntity) private readonly jobs: Repository<JobEntity>,
    @InjectRepository(JobPostVersionEntity)
    private readonly versions: Repository<JobPostVersionEntity>,
    @InjectRepository(BusinessProfileEntity)
    private readonly profiles: Repository<BusinessProfileEntity>,
    private readonly dataSource: DataSource,
    private readonly scanner: SkillTextScannerService,
    private readonly ingest: JdIngestService,
  ) {}

  async createDraft(userId: string, input: JobDraftInput) {
    const profile = await this.requireProfile(userId);
    const title = input.title?.trim();
    if (!title)
      throw new BadRequestException({
        errorCode: 'VALIDATION_ERROR',
        message: 'title is required',
      });
    return this.dataSource.transaction(async (manager) => {
      const jobs = manager.getRepository(JobEntity);
      const versions = manager.getRepository(JobPostVersionEntity);
      const job = await jobs.save(
        jobs.create({
          companyId: profile.companyId,
          createdByUserId: userId,
          slug: createJobSlug(title),
          title,
          roleCode: input.roleCode ?? null,
          status: 'draft',
          sourceType: 'employer',
          sourceName: `employer:${profile.companyId}`,
          applicationMode: 'NATIVE',
          currency: input.currency ?? 'VND',
          salaryVisible: input.salaryVisible ?? true,
          salaryNegotiable: input.salaryNegotiable ?? false,
          openingsCount: input.openingsCount ?? 1,
          locationCityCodes: [],
        }),
      );
      const draft = versions.create({
        jobId: job.id,
        versionNo: 1,
        status: 'DRAFT',
        revision: 1,
        createdByUserId: userId,
        title,
        openingsCount: 1,
        currency: input.currency ?? 'VND',
        salaryVisible: input.salaryVisible ?? true,
        salaryNegotiable: input.salaryNegotiable ?? false,
        responsibilities: [],
        requirements: [],
        niceToHave: [],
        benefits: [],
        interviewProcess: [],
        locations: [],
        skills: [],
      });
      assignDraft(draft, input);
      return { job, draft: await versions.save(draft) };
    });
  }

  async listMine(userId: string, page = 1, limit = 20, status?: JobEntity['status']) {
    const profile = await this.requireProfile(userId);
    const take = Math.min(Math.max(limit, 1), 100);
    const [items, total] = await this.jobs.findAndCount({
      where: { companyId: profile.companyId, ...(status ? { status } : {}) },
      order: { createdAt: 'DESC' },
      skip: (Math.max(page, 1) - 1) * take,
      take,
    });
    return { items, total, page: Math.max(page, 1), limit: take };
  }

  async getMine(userId: string, jobId: string) {
    const job = await this.requireOwnedJob(userId, jobId);
    const [draft, published] = await Promise.all([
      this.versions.findOne({ where: { jobId, status: 'DRAFT' } }),
      job.currentPublishedVersionId
        ? this.versions.findOne({ where: { id: job.currentPublishedVersionId } })
        : Promise.resolve(null),
    ]);
    return { job, draft, published };
  }

  async updateDraft(userId: string, jobId: string, input: JobDraftInput) {
    await this.requireOwnedJob(userId, jobId);
    return this.dataSource.transaction(async (manager) => {
      const jobs = manager.getRepository(JobEntity);
      const versions = manager.getRepository(JobPostVersionEntity);
      const job = await jobs.findOne({ where: { id: jobId }, lock: { mode: 'pessimistic_write' } });
      if (!job)
        throw new NotFoundException({ errorCode: 'JOB_NOT_FOUND', message: 'Job not found' });
      if (job.status === 'closed' || job.status === 'expired' || job.status === 'removed') {
        throw new ConflictException({
          errorCode: 'JOB_NOT_EDITABLE',
          message: 'Closed, expired, or removed jobs cannot be edited',
        });
      }
      let draft = await versions.findOne({
        where: { jobId, status: 'DRAFT' },
        lock: { mode: 'pessimistic_write' },
      });
      if (!draft) {
        const published = job.currentPublishedVersionId
          ? await versions.findOne({
              where: { id: job.currentPublishedVersionId },
              lock: { mode: 'pessimistic_read' },
            })
          : null;
        if (!published)
          throw new NotFoundException({
            errorCode: 'JOB_NOT_FOUND',
            message: 'Job draft not found',
          });
        if (input.expectedRevision !== undefined)
          assertExpectedRevision(input.expectedRevision, published.revision);
        draft = versions.create(clonePublishedVersion(published, userId));
      } else if (input.expectedRevision !== undefined) {
        assertExpectedRevision(input.expectedRevision, draft.revision);
      }
      const resetsSkills = [
        'title',
        'roleCode',
        'responsibilities',
        'requirements',
        'niceToHave',
      ].some((key) => input[key as keyof JobDraftInput] !== undefined);
      assignDraft(draft, input);
      draft.revision += 1;
      if (resetsSkills) draft.skillsConfirmedAt = null;
      return versions.save(draft);
    });
  }

  async extractDraftSkills(userId: string, jobId: string, expectedRevision: number) {
    await this.requireOwnedJob(userId, jobId);
    return this.dataSource.transaction(async (manager) => {
      const jobs = manager.getRepository(JobEntity);
      const versions = manager.getRepository(JobPostVersionEntity);
      const skillRows = manager.getRepository(SkillEntity);
      const job = await jobs.findOne({ where: { id: jobId }, lock: { mode: 'pessimistic_write' } });
      if (!job)
        throw new NotFoundException({ errorCode: 'JOB_NOT_FOUND', message: 'Job not found' });
      if (!['draft', 'active'].includes(job.status)) {
        throw new ConflictException({
          errorCode: 'JOB_NOT_EDITABLE',
          message: 'Closed, expired, or removed jobs cannot be edited',
        });
      }
      const draft = await versions.findOne({
        where: { jobId, status: 'DRAFT' },
        lock: { mode: 'pessimistic_write' },
      });
      if (!draft)
        throw new NotFoundException({ errorCode: 'JOB_NOT_FOUND', message: 'Job draft not found' });
      assertExpectedRevision(expectedRevision, draft.revision);
      const requiredText = [
        draft.title,
        draft.summary,
        ...draft.responsibilities,
        ...draft.requirements,
      ]
        .filter(Boolean)
        .join('\n');
      const niceText = draft.niceToHave.join('\n');
      const found = this.scanner.scan(`${requiredText}\n${niceText}`);
      const requiredCanonicals = new Set(
        this.scanner.scan(requiredText).map((hit) => hit.canonical_name),
      );
      const rows = found.length
        ? await skillRows.find({
            where: { canonicalName: In(found.map((item) => item.canonical_name)) },
          })
        : [];
      const byCanonical = new Map(rows.map((row) => [row.canonicalName, row]));
      draft.skills = found.flatMap((item): JobSkillSnapshot[] => {
        const row = byCanonical.get(item.canonical_name);
        if (!row) return [];
        return [
          {
            skillId: row.id,
            canonicalName: row.canonicalName,
            importance: requiredCanonicals.has(item.canonical_name) ? 'REQUIRED' : 'NICE_TO_HAVE',
            minLevel: null,
            source: 'AUTO',
            confidence: 0.9,
            rawText: item.matched_text,
          },
        ];
      });
      draft.skillsConfirmedAt = null;
      draft.revision += 1;
      return versions.save(draft);
    });
  }

  async replaceDraftSkills(
    userId: string,
    jobId: string,
    expectedRevision: number,
    skills: JobSkillSnapshot[],
  ) {
    await this.requireOwnedJob(userId, jobId);
    return this.dataSource.transaction(async (manager) => {
      const jobs = manager.getRepository(JobEntity);
      const versions = manager.getRepository(JobPostVersionEntity);
      const skillRows = manager.getRepository(SkillEntity);
      const job = await jobs.findOne({ where: { id: jobId }, lock: { mode: 'pessimistic_write' } });
      if (!job)
        throw new NotFoundException({ errorCode: 'JOB_NOT_FOUND', message: 'Job not found' });
      const draft = await versions.findOne({
        where: { jobId, status: 'DRAFT' },
        lock: { mode: 'pessimistic_write' },
      });
      if (!draft)
        throw new NotFoundException({ errorCode: 'JOB_NOT_FOUND', message: 'Job draft not found' });
      assertExpectedRevision(expectedRevision, draft.revision);
      const ids = [...new Set(skills.map((skill) => skill.skillId))];
      const existing = ids.length ? await skillRows.find({ where: { id: In(ids) } }) : [];
      if (existing.length !== ids.length || skills.length === 0) {
        throw new BadRequestException({
          errorCode: 'VALIDATION_ERROR',
          message: 'At least one valid taxonomy skill is required',
        });
      }
      const byId = new Map(existing.map((skill) => [skill.id, skill]));
      draft.skills = skills.map((skill) => ({
        ...skill,
        canonicalName: byId.get(skill.skillId)!.canonicalName,
        source: 'BUSINESS',
      }));
      draft.skillsConfirmedAt = new Date();
      draft.revision += 1;
      return versions.save(draft);
    });
  }

  async publish(userId: string, jobId: string, expectedRevision: number) {
    const profile = await this.requireProfile(userId);
    if (profile.status !== 'VERIFIED') {
      throw new ForbiddenException({
        errorCode: 'BUSINESS_NOT_VERIFIED',
        message: 'Verified company is required to publish jobs',
      });
    }
    await this.requireOwnedJob(userId, jobId);
    const result = await this.dataSource.transaction(async (manager) => {
      const jobs = manager.getRepository(JobEntity);
      const versions = manager.getRepository(JobPostVersionEntity);
      const profiles = manager.getRepository(BusinessProfileEntity);
      const lockedProfile = await profiles.findOne({
        where: { id: profile.id },
        lock: { mode: 'pessimistic_read' },
      });
      if (!lockedProfile || lockedProfile.status !== 'VERIFIED') {
        throw new ForbiddenException({
          errorCode: 'BUSINESS_NOT_VERIFIED',
          message: 'Verified company is required to publish jobs',
        });
      }
      const job = await jobs.findOne({ where: { id: jobId }, lock: { mode: 'pessimistic_write' } });
      if (!job)
        throw new NotFoundException({ errorCode: 'JOB_NOT_FOUND', message: 'Job not found' });
      if (!['draft', 'active'].includes(job.status)) {
        throw new ConflictException({
          errorCode: 'JOB_NOT_EDITABLE',
          message: 'Closed, expired, or removed jobs cannot be published',
        });
      }
      const draft = await versions.findOne({
        where: { jobId, status: 'DRAFT' },
        lock: { mode: 'pessimistic_write' },
      });
      if (!draft) {
        throw new ConflictException({
          errorCode: 'JOB_VERSION_CHANGED',
          message: 'The draft was already published or replaced',
        });
      }
      assertExpectedRevision(expectedRevision, draft.revision);
      assertPublishableDraft(draft);
      if (!draft.applicationDeadline) {
        throw new BadRequestException({
          errorCode: 'VALIDATION_ERROR',
          message: 'applicationDeadline is required',
        });
      }
      assertPublishDeadline(draft.applicationDeadline);
      if (draft.salaryMin && draft.salaryMax && Number(draft.salaryMin) > Number(draft.salaryMax)) {
        throw new BadRequestException({
          errorCode: 'VALIDATION_ERROR',
          message: 'salaryMin must not exceed salaryMax',
        });
      }
      if (job.currentPublishedVersionId) {
        const current = await versions.findOne({
          where: { id: job.currentPublishedVersionId },
          lock: { mode: 'pessimistic_write' },
        });
        if (current) {
          current.status = 'SUPERSEDED';
          await versions.save(current);
        }
      }
      draft.status = 'PUBLISHED';
      draft.publishedAt = new Date();
      await versions.save(draft);
      applyPublishedVersion(job, draft);
      await jobs.save(job);
      await manager.query(`DELETE FROM public.job_skills WHERE job_id = $1`, [job.id]);
      for (const skill of draft.skills) {
        await manager.query(
          `INSERT INTO public.job_skills (job_id, skill_id, importance, min_level, confidence, raw_text)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (job_id, skill_id) DO NOTHING`,
          [
            job.id,
            skill.skillId,
            skill.importance,
            skill.minLevel,
            skill.confidence,
            skill.rawText,
          ],
        );
      }
      return { job, published: draft };
    });
    await this.ingest
      .refreshEmployerJobEmbedding(
        result.job.id,
        result.published.skills.map((skill) => skill.canonicalName).sort(),
      )
      .catch(() => undefined);
    return result;
  }

  async close(userId: string, jobId: string) {
    const job = await this.requireOwnedJob(userId, jobId);
    if (job.status !== 'active')
      throw new ConflictException({ errorCode: 'JOB_NOT_ACTIVE', message: 'Job is not active' });
    job.status = 'closed';
    job.closedAt = new Date();
    return this.jobs.save(job);
  }

  async duplicate(userId: string, jobId: string) {
    const source = await this.requireOwnedJob(userId, jobId);
    if (!['closed', 'expired'].includes(source.status)) {
      throw new ConflictException({
        errorCode: 'JOB_NOT_EDITABLE',
        message: 'Only closed or expired jobs can be duplicated',
      });
    }
    const published = source.currentPublishedVersionId
      ? await this.versions.findOne({ where: { id: source.currentPublishedVersionId } })
      : null;
    if (!published)
      throw new NotFoundException({
        errorCode: 'JOB_NOT_FOUND',
        message: 'Published version not found',
      });
    const result = await this.createDraft(userId, cloneAsInput(published));
    result.draft.skills = published.skills.map((skill) => ({ ...skill }));
    result.draft.skillsConfirmedAt = null;
    return { job: result.job, draft: await this.versions.save(result.draft) };
  }

  async deleteDraft(userId: string, jobId: string): Promise<{ deleted: true }> {
    const job = await this.requireOwnedJob(userId, jobId);
    if (job.currentPublishedVersionId || job.status !== 'draft') {
      throw new ConflictException({
        errorCode: 'JOB_NOT_EDITABLE',
        message: 'Only never-published drafts can be deleted',
      });
    }
    await this.jobs.remove(job);
    return { deleted: true };
  }

  private async requireOwnedJob(userId: string, jobId: string): Promise<JobEntity> {
    const profile = await this.requireProfile(userId);
    const job = await this.jobs.findOne({ where: { id: jobId } });
    if (!job) throw new NotFoundException({ errorCode: 'JOB_NOT_FOUND', message: 'Job not found' });
    if (job.companyId !== profile.companyId || job.sourceType !== 'employer') {
      throw new ForbiddenException({
        errorCode: 'JOB_NOT_OWNED',
        message: 'Job does not belong to this company',
      });
    }
    return job;
  }

  private async requireProfile(userId: string): Promise<BusinessProfileEntity> {
    const profile = await this.profiles.findOne({ where: { userId } });
    if (!profile)
      throw new NotFoundException({
        errorCode: 'BUSINESS_PROFILE_NOT_FOUND',
        message: 'Business profile not found',
      });
    return profile;
  }
}

function assignDraft(draft: JobPostVersionEntity, input: JobDraftInput): void {
  const fields: Array<keyof JobDraftInput> = [
    'title',
    'roleCode',
    'employmentType',
    'experienceLevel',
    'workMode',
    'openingsCount',
    'currency',
    'salaryPeriod',
    'salaryVisible',
    'salaryNegotiable',
    'educationLevel',
    'languageCode',
    'summary',
    'responsibilities',
    'requirements',
    'niceToHave',
    'benefits',
    'interviewProcess',
    'workingTime',
    'locations',
  ];
  for (const key of fields) {
    if (input[key] !== undefined) (draft as unknown as Record<string, unknown>)[key] = input[key];
  }
  if (input.minYearsExperience !== undefined)
    draft.minYearsExperience = numeric(input.minYearsExperience);
  if (input.maxYearsExperience !== undefined)
    draft.maxYearsExperience = numeric(input.maxYearsExperience);
  if (input.salaryMin !== undefined) draft.salaryMin = numeric(input.salaryMin);
  if (input.salaryMax !== undefined) draft.salaryMax = numeric(input.salaryMax);
  if (input.applicationDeadline !== undefined) {
    draft.applicationDeadline = input.applicationDeadline
      ? new Date(input.applicationDeadline)
      : null;
  }
}

function clonePublishedVersion(
  source: JobPostVersionEntity,
  userId: string,
): Partial<JobPostVersionEntity> {
  const clone = cloneAsInput(source);
  return {
    jobId: source.jobId,
    versionNo: source.versionNo + 1,
    status: 'DRAFT',
    revision: 1,
    createdByUserId: userId,
    title: clone.title!,
    roleCode: clone.roleCode ?? null,
    employmentType: clone.employmentType ?? null,
    experienceLevel: clone.experienceLevel ?? null,
    minYearsExperience: numeric(clone.minYearsExperience),
    maxYearsExperience: numeric(clone.maxYearsExperience),
    workMode: clone.workMode ?? null,
    openingsCount: clone.openingsCount ?? 1,
    salaryMin: numeric(clone.salaryMin),
    salaryMax: numeric(clone.salaryMax),
    currency: clone.currency ?? 'VND',
    salaryPeriod: clone.salaryPeriod ?? null,
    salaryVisible: clone.salaryVisible ?? true,
    salaryNegotiable: clone.salaryNegotiable ?? false,
    educationLevel: clone.educationLevel ?? null,
    languageCode: clone.languageCode ?? null,
    applicationDeadline: source.applicationDeadline,
    summary: clone.summary ?? null,
    responsibilities: [...(clone.responsibilities ?? [])],
    requirements: [...(clone.requirements ?? [])],
    niceToHave: [...(clone.niceToHave ?? [])],
    benefits: [...(clone.benefits ?? [])],
    interviewProcess: [...(clone.interviewProcess ?? [])],
    workingTime: clone.workingTime ?? null,
    locations: (clone.locations ?? []).map((location) => ({ ...location })),
    skills: source.skills.map((skill) => ({ ...skill })),
    skillsConfirmedAt: null,
    publishedAt: null,
  };
}

function cloneAsInput(source: JobPostVersionEntity): JobDraftInput {
  return {
    title: source.title,
    roleCode: source.roleCode,
    employmentType: source.employmentType,
    experienceLevel: source.experienceLevel,
    minYearsExperience:
      source.minYearsExperience === null ? null : Number(source.minYearsExperience),
    maxYearsExperience:
      source.maxYearsExperience === null ? null : Number(source.maxYearsExperience),
    workMode: source.workMode,
    openingsCount: source.openingsCount,
    salaryMin: source.salaryMin === null ? null : Number(source.salaryMin),
    salaryMax: source.salaryMax === null ? null : Number(source.salaryMax),
    currency: source.currency,
    salaryPeriod: source.salaryPeriod,
    salaryVisible: source.salaryVisible,
    salaryNegotiable: source.salaryNegotiable,
    educationLevel: source.educationLevel,
    languageCode: source.languageCode,
    summary: source.summary,
    responsibilities: [...source.responsibilities],
    requirements: [...source.requirements],
    niceToHave: [...source.niceToHave],
    benefits: [...source.benefits],
    interviewProcess: [...source.interviewProcess],
    workingTime: source.workingTime,
    locations: source.locations.map((location) => ({ ...location })),
  };
}

function applyPublishedVersion(job: JobEntity, version: JobPostVersionEntity): void {
  job.currentPublishedVersionId = version.id;
  job.title = version.title;
  job.roleCode = version.roleCode;
  job.employmentType = version.employmentType;
  job.experienceLevel = version.experienceLevel;
  job.minYearsExperience = version.minYearsExperience;
  job.maxYearsExperience = version.maxYearsExperience;
  job.workMode = version.workMode;
  job.openingsCount = version.openingsCount;
  job.salaryMin = version.salaryMin;
  job.salaryMax = version.salaryMax;
  job.currency = version.currency;
  job.salaryPeriod = version.salaryPeriod;
  job.salaryVisible = version.salaryVisible;
  job.salaryNegotiable = version.salaryNegotiable;
  job.primaryCityCode =
    version.locations.find((location) => location.isPrimary)?.cityCode ??
    version.locations[0]?.cityCode ??
    null;
  job.locationCityCodes = [...new Set(version.locations.map((location) => location.cityCode))];
  job.location = version.locations.map((location) => location.cityCode).join(', ');
  job.status = 'active';
  job.postedAt = version.publishedAt;
  job.lastSeenAt = version.publishedAt;
  job.expiresAt = version.applicationDeadline;
  job.closedAt = null;
}

function numeric(value: number | null | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function createJobSlug(title: string): string {
  const base =
    title
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 240) || 'job';
  return `${base}-${randomBytes(4).toString('hex')}`;
}

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'crypto';
import { DataSource, In, Repository } from 'typeorm';
import { CvEntity } from '../../database/entities/cv.entity';
import { CvSkillEntity } from '../../database/entities/cv-skill.entity';
import { JobApplicationStatusEventEntity } from '../../database/entities/job-application-status-event.entity';
import { JobApplicationEntity } from '../../database/entities/job-application.entity';
import { JobPostVersionEntity } from '../../database/entities/job-post-version.entity';
import { JobReportEntity, JobReportReason } from '../../database/entities/job-report.entity';
import { JobEntity } from '../../database/entities/job.entity';
import { SavedJobEntity } from '../../database/entities/saved-job.entity';
import { SkillEntity } from '../../database/entities/skill.entity';
import { UserEntity } from '../../database/entities/user.entity';
import { GcsStorageService } from '../../infrastructure/storage/gcs-storage.service';
import { SkillDiffService } from '../../modules/cv-jd-match/skill-diff.service';
import { CvPdfRendererService } from '../cvs/cv-pdf-renderer.service';
import { ApplyToJobDto } from './dto/business-jobs.dto';
import { BusinessJobsMaintenanceService } from './business-jobs-maintenance.service';
import {
  assertApplicationTransition,
  assertApplyableJob,
  isPubliclyVisibleJob,
  proficiencyHintForLevel,
  publicSalary,
  retentionDateForApplication,
  safeApplication,
} from './job-domain';

@Injectable()
export class CandidateJobService {
  constructor(
    @InjectRepository(JobEntity) private readonly jobs: Repository<JobEntity>,
    @InjectRepository(JobPostVersionEntity)
    private readonly versions: Repository<JobPostVersionEntity>,
    @InjectRepository(SavedJobEntity) private readonly savedJobs: Repository<SavedJobEntity>,
    @InjectRepository(JobApplicationEntity)
    private readonly applications: Repository<JobApplicationEntity>,
    @InjectRepository(JobApplicationStatusEventEntity)
    private readonly events: Repository<JobApplicationStatusEventEntity>,
    @InjectRepository(JobReportEntity) private readonly reports: Repository<JobReportEntity>,
    @InjectRepository(CvEntity) private readonly cvs: Repository<CvEntity>,
    @InjectRepository(CvSkillEntity) private readonly cvSkills: Repository<CvSkillEntity>,
    @InjectRepository(SkillEntity) private readonly skills: Repository<SkillEntity>,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    private readonly storage: GcsStorageService,
    private readonly pdfRenderer: CvPdfRendererService,
    private readonly skillDiff: SkillDiffService,
    private readonly dataSource: DataSource,
    private readonly maintenance: BusinessJobsMaintenanceService,
  ) {}

  async listSaved(userId: string, page = 1, limit = 20) {
    const take = Math.min(Math.max(limit, 1), 100);
    const [saved, total] = await this.savedJobs.findAndCount({
      where: { userId },
      order: { createdAt: 'DESC' },
      skip: (Math.max(page, 1) - 1) * take,
      take,
    });
    const jobs = saved.length
      ? await this.jobs.find({ where: { id: In(saved.map((item) => item.jobId)) } })
      : [];
    const nativeCompanyIds = [
      ...new Set(
        jobs.filter((job) => job.applicationMode === 'NATIVE').map((job) => job.companyId),
      ),
    ];
    const verifiedRows = nativeCompanyIds.length
      ? await this.dataSource.query<Array<{ company_id: string }>>(
          `SELECT company_id
             FROM public.business_profiles
            WHERE status = 'VERIFIED' AND company_id = ANY($1::uuid[])`,
          [nativeCompanyIds],
        )
      : [];
    const verifiedCompanyIds = new Set(verifiedRows.map((row) => row.company_id));
    const byId = new Map(jobs.map((job) => [job.id, job]));
    return {
      items: saved.flatMap((item) => {
        const job = byId.get(item.jobId);
        return job
          ? [
              {
                savedAt: item.createdAt,
                job: safeSavedJob(job, verifiedCompanyIds.has(job.companyId)),
              },
            ]
          : [];
      }),
      total,
      page: Math.max(page, 1),
      limit: take,
    };
  }

  async saveJob(userId: string, jobId: string) {
    await this.requirePublicJob(jobId);
    const existing = await this.savedJobs.findOne({ where: { userId, jobId } });
    if (existing) return existing;
    try {
      return await this.savedJobs.save(this.savedJobs.create({ userId, jobId }));
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        const concurrent = await this.savedJobs.findOne({ where: { userId, jobId } });
        if (concurrent) return concurrent;
      }
      throw error;
    }
  }

  async removeSavedJob(userId: string, jobId: string): Promise<{ deleted: true }> {
    await this.savedJobs.delete({ userId, jobId });
    return { deleted: true };
  }

  async apply(userId: string, jobId: string, input: ApplyToJobDto) {
    const job = await this.requirePublicJob(jobId);
    assertApplyableJob(job, input.jobVersionId);
    const version = await this.versions.findOne({ where: { id: input.jobVersionId, jobId } });
    if (!version || version.status !== 'PUBLISHED') {
      throw new ConflictException({
        errorCode: 'JOB_VERSION_CHANGED',
        message: 'Published job version changed',
      });
    }
    if (await this.applications.findOne({ where: { jobId, candidateUserId: userId } })) {
      throw new ConflictException({
        errorCode: 'JOB_APPLICATION_ALREADY_EXISTS',
        message: 'You already applied to this job',
      });
    }
    const cv = await this.cvs.findOne({ where: { id: input.cvId, userId } });
    if (!cv) throw new NotFoundException({ errorCode: 'NOT_FOUND', message: 'CV not found' });
    const user = await this.users.findOne({
      where: { id: userId, status: 'ACTIVE', isActive: true },
    });
    if (!user) {
      throw new NotFoundException({
        errorCode: 'NOT_FOUND',
        message: 'Candidate account not found',
      });
    }
    const contact = snapshotCandidateContact(user, input);
    const cvSkillSnapshot = await this.loadCvSkillSnapshot(cv.id);
    const applicationId = randomUUID();
    let snapshot: Awaited<ReturnType<CandidateJobService['snapshotCv']>>;
    try {
      snapshot = await this.snapshotCv(userId, applicationId, cv);
    } catch {
      throw new ConflictException({
        errorCode: 'CV_SNAPSHOT_FAILED',
        message: 'CV could not be snapshotted for this application',
      });
    }
    const application = this.applications.create({
      id: applicationId,
      jobId,
      jobVersionId: version.id,
      candidateUserId: userId,
      sourceCvId: cv.id,
      status: 'SUBMITTED',
      coverNote: input.coverNote?.trim() || null,
      candidateName: contact.name,
      candidateEmail: contact.email,
      candidatePhone: contact.phone,
      consentVersion: input.consentVersion,
      consentAcceptedAt: new Date(),
      cvStorageObjectKey: snapshot.key,
      cvOriginalFileName: snapshot.fileName,
      cvContentType: snapshot.contentType,
      cvFileSize: snapshot.buffer.length,
      cvChecksumSha256: createHash('sha256').update(snapshot.buffer).digest('hex'),
      cvKind: cv.cvKind,
      cvSkillsSnapshot: cvSkillSnapshot,
      matchStatus: 'PENDING',
      submittedAt: new Date(),
    });

    try {
      let notificationEventId: string | null = null;
      await this.dataSource.transaction(async (manager) => {
        const currentJob = await manager.getRepository(JobEntity).findOne({
          where: { id: jobId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!currentJob) {
          throw new NotFoundException({ errorCode: 'JOB_NOT_FOUND', message: 'Job not found' });
        }
        assertApplyableJob(currentJob, input.jobVersionId);
        const currentVersion = await manager.getRepository(JobPostVersionEntity).findOne({
          where: { id: input.jobVersionId, jobId, status: 'PUBLISHED' },
          lock: { mode: 'pessimistic_read' },
        });
        if (!currentVersion) {
          throw new ConflictException({
            errorCode: 'JOB_VERSION_CHANGED',
            message: 'Published job version changed',
          });
        }
        await manager.getRepository(JobApplicationEntity).save(application);
        const savedEvent = await manager.getRepository(JobApplicationStatusEventEntity).save(
          manager.getRepository(JobApplicationStatusEventEntity).create({
            applicationId,
            fromStatus: null,
            toStatus: 'SUBMITTED',
            actorUserId: userId,
            notificationType: 'NEW_APPLICATION',
            notificationStatus: 'PENDING',
            notificationAttemptCount: 0,
            notificationNextAttemptAt: new Date(),
          }),
        );
        notificationEventId = savedEvent.id;
      });
      if (notificationEventId) {
        await this.maintenance.processNotificationEvent(notificationEventId).catch(() => false);
      }
    } catch (error) {
      await this.storage.delete(snapshot.key).catch(() => undefined);
      if ((error as { code?: string }).code === '23505') {
        throw new ConflictException({
          errorCode: 'JOB_APPLICATION_ALREADY_EXISTS',
          message: 'You already applied to this job',
        });
      }
      throw error;
    }

    try {
      const match = this.computeMatch(cvSkillSnapshot, version);
      application.matchStatus = 'READY';
      application.matchScore = String(match.overall_score);
      application.matchScoringVersion = 'skill-diff-v1';
      application.matchResult = match;
      application.matchComputedAt = new Date();
    } catch {
      application.matchStatus = 'FAILED';
      application.matchErrorCode = 'MATCH_COMPUTATION_FAILED';
    }
    try {
      await this.applications.save(application);
    } catch {
      application.matchStatus = 'FAILED';
      application.matchScore = null;
      application.matchResult = null;
      application.matchComputedAt = null;
      application.matchErrorCode = 'MATCH_SNAPSHOT_PERSIST_FAILED';
      await this.applications
        .update(
          { id: application.id },
          {
            matchStatus: 'FAILED',
            matchErrorCode: application.matchErrorCode,
          },
        )
        .catch(() => undefined);
    }
    return safeApplication(application);
  }

  async matchJob(userId: string, jobId: string, cvId: string) {
    const [job, cv] = await Promise.all([
      this.requirePublicJob(jobId),
      this.cvs.findOne({ where: { id: cvId, userId } }),
    ]);
    if (!cv) throw new NotFoundException({ errorCode: 'NOT_FOUND', message: 'CV not found' });
    const version = job.currentPublishedVersionId
      ? await this.versions.findOne({ where: { id: job.currentPublishedVersionId } })
      : null;
    if (!version)
      throw new NotFoundException({
        errorCode: 'JOB_NOT_FOUND',
        message: 'Job match data is unavailable',
      });
    return this.computeMatch(await this.loadCvSkillSnapshot(cv.id), version);
  }

  async listMyApplications(userId: string, page = 1, limit = 20) {
    const take = Math.min(Math.max(limit, 1), 100);
    const [items, total] = await this.applications.findAndCount({
      where: { candidateUserId: userId },
      order: { submittedAt: 'DESC' },
      skip: (Math.max(page, 1) - 1) * take,
      take,
    });
    return { items: items.map(safeApplication), total, page: Math.max(page, 1), limit: take };
  }

  async getMyApplication(userId: string, applicationId: string) {
    const application = await this.applications.findOne({
      where: { id: applicationId, candidateUserId: userId },
    });
    if (!application) throw this.applicationNotFound();
    const events = await this.events.find({
      where: { applicationId },
      order: { createdAt: 'ASC' },
    });
    return {
      application: safeApplication(application),
      events: events.map(({ internalNote: _internal, ...event }) => event),
    };
  }

  async withdraw(userId: string, applicationId: string) {
    const now = new Date();
    const withdrawn = await this.dataSource.transaction(async (manager) => {
      const applications = manager.getRepository(JobApplicationEntity);
      const events = manager.getRepository(JobApplicationStatusEventEntity);
      const application = await applications.findOne({
        where: { id: applicationId, candidateUserId: userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!application) throw this.applicationNotFound();
      assertApplicationTransition(application.status, 'WITHDRAWN');
      const fromStatus = application.status;
      application.status = 'WITHDRAWN';
      application.withdrawnAt = now;
      application.terminalAt = now;
      application.piiPurgeAfter = retentionDateForApplication({
        status: 'WITHDRAWN',
        terminalAt: now,
        jobEndedAt: null,
      });
      await applications.save(application);
      await events.save(
        events.create({
          applicationId: application.id,
          fromStatus,
          toStatus: 'WITHDRAWN',
          actorUserId: userId,
          notificationType: 'NONE',
          notificationStatus: 'NOT_REQUIRED',
        }),
      );
      return application;
    });
    return safeApplication(withdrawn);
  }

  async reportJob(userId: string, jobId: string, reasonCode: JobReportReason, details?: string) {
    await this.requireJob(jobId);
    if (await this.reports.findOne({ where: { jobId, reporterUserId: userId } })) {
      throw new ConflictException({
        errorCode: 'JOB_REPORT_ALREADY_EXISTS',
        message: 'You already reported this job',
      });
    }
    try {
      return await this.reports.save(
        this.reports.create({
          jobId,
          reporterUserId: userId,
          reasonCode,
          details: details?.trim() || null,
          status: 'OPEN',
        }),
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new ConflictException({
          errorCode: 'JOB_REPORT_ALREADY_EXISTS',
          message: 'You already reported this job',
        });
      }
      throw error;
    }
  }

  private async loadCvSkillSnapshot(
    cvId: string,
  ): Promise<Array<{ skillId: string; canonicalName: string; displayName: string }>> {
    const links = await this.cvSkills.find({ where: { cvId } });
    const rows = links.length
      ? await this.skills.find({ where: { id: In(links.map((link) => link.skillId)) } })
      : [];
    return rows.map((skill) => ({
      skillId: skill.id,
      canonicalName: skill.canonicalName,
      displayName: skill.displayName,
    }));
  }

  private computeMatch(cvSkills: Array<{ canonicalName: string }>, version: JobPostVersionEntity) {
    return this.skillDiff.diff({
      cv_skills_raw: cvSkills.map((skill) => ({ name: skill.canonicalName })),
      jd_requirements_raw: version.skills.map((skill) => ({
        name: skill.canonicalName,
        importance_hint: skill.importance,
        required_level_hint: proficiencyHintForLevel(skill.minLevel),
        evidence_text: skill.rawText ?? undefined,
      })),
      target_role: version.roleCode,
    });
  }

  private async snapshotCv(userId: string, applicationId: string, cv: CvEntity) {
    let buffer: Buffer;
    let contentType: string;
    let fileName: string;
    if (cv.cvKind === 'BUILT') {
      const rendered = await this.pdfRenderer.renderHarvardPdf(cv);
      buffer = rendered.buffer;
      contentType = 'application/pdf';
      fileName = rendered.fileName;
    } else {
      if (!cv.fileUrl) {
        throw new ConflictException({
          errorCode: 'CV_SNAPSHOT_FAILED',
          message: 'Original CV file is unavailable',
        });
      }
      const file = await this.storage.download(cv.fileUrl);
      buffer = await readableToBuffer(file.body);
      contentType = file.contentType ?? cv.fileType ?? 'application/octet-stream';
      fileName = cv.originalFileName ?? `${cv.id}-cv`;
    }
    const key = this.storage.buildApplicationCvObjectKey(applicationId, fileName);
    await this.storage.upload({ key, body: buffer, contentType });
    return { key, buffer, contentType, fileName, userId };
  }

  private async requireJob(jobId: string): Promise<JobEntity> {
    const job = await this.jobs.findOne({ where: { id: jobId } });
    if (!job) throw this.jobNotFound();
    return job;
  }

  private async requirePublicJob(jobId: string): Promise<JobEntity> {
    const job = await this.jobs.findOne({ where: { id: jobId } });
    if (!job) throw this.jobNotFound();
    let companyVerified = false;
    if (job.applicationMode === 'NATIVE') {
      const rows = await this.dataSource.query<Array<{ visible: boolean }>>(
        `SELECT EXISTS (
           SELECT 1 FROM public.business_profiles
            WHERE company_id = $1 AND status = 'VERIFIED'
         ) AS visible`,
        [job.companyId],
      );
      companyVerified = rows[0]?.visible === true;
    }
    if (!isPubliclyVisibleJob(job, companyVerified)) throw this.jobNotFound();
    return job;
  }

  private jobNotFound(): NotFoundException {
    return new NotFoundException({ errorCode: 'JOB_NOT_FOUND', message: 'Job not found' });
  }

  private applicationNotFound(): NotFoundException {
    return new NotFoundException({
      errorCode: 'JOB_APPLICATION_NOT_FOUND',
      message: 'Job application not found',
    });
  }
}

export function snapshotCandidateContact(
  user: Pick<UserEntity, 'email' | 'emailNormalized' | 'fullName'>,
  input: Pick<ApplyToJobDto, 'candidateName' | 'candidateEmail' | 'candidatePhone'>,
) {
  const requestedEmail = input.candidateEmail.trim().toLowerCase();
  const accountEmail = (user.emailNormalized || user.email).trim().toLowerCase();
  if (requestedEmail !== accountEmail) {
    throw new BadRequestException({
      errorCode: 'VALIDATION_ERROR',
      message: 'Candidate email must match the authenticated account',
    });
  }
  return {
    name: user.fullName?.trim() || input.candidateName.trim(),
    email: accountEmail,
    phone: input.candidatePhone?.trim() || null,
  };
}

export function safeSavedJob(job: JobEntity, companyVerified = job.applicationMode === 'EXTERNAL') {
  return {
    id: job.id,
    slug: job.slug,
    title: job.title,
    roleCode: job.roleCode,
    location: job.location,
    cityCodes: job.locationCityCodes,
    workMode: job.workMode,
    employmentType: job.employmentType,
    experienceLevel: job.experienceLevel,
    salary: publicSalary({
      visible: job.salaryVisible,
      min: job.salaryMin === null ? null : Number(job.salaryMin),
      max: job.salaryMax === null ? null : Number(job.salaryMax),
      currency: job.currency,
      period: job.salaryPeriod,
      negotiable: job.salaryNegotiable,
    }),
    applicationMode: job.applicationMode,
    canApply:
      job.applicationMode === 'NATIVE' &&
      Boolean(job.currentPublishedVersionId) &&
      isPubliclyVisibleJob(job, companyVerified),
    sourceUrl: job.applicationMode === 'EXTERNAL' ? job.sourceUrl : null,
    currentVersionId: job.applicationMode === 'NATIVE' ? job.currentPublishedVersionId : null,
    postedAt: job.postedAt,
    expiresAt: job.expiresAt,
  };
}

async function readableToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

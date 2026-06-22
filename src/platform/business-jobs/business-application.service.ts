import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, FindOptionsOrder, ILike, Repository } from 'typeorm';
import { BusinessProfileEntity } from '../../database/entities/business-profile.entity';
import { JobApplicationStatusEventEntity } from '../../database/entities/job-application-status-event.entity';
import { JobApplicationEntity } from '../../database/entities/job-application.entity';
import { JobEntity } from '../../database/entities/job.entity';
import {
  DownloadedFile,
  GcsStorageService,
} from '../../infrastructure/storage/gcs-storage.service';
import { ListApplicationsQueryDto, UpdateApplicationStatusDto } from './dto/business-jobs.dto';
import { BusinessJobsMaintenanceService } from './business-jobs-maintenance.service';
import {
  assertApplicationTransition,
  retentionDateForApplication,
  safeApplication,
} from './job-domain';

@Injectable()
export class BusinessApplicationService {
  constructor(
    @InjectRepository(JobApplicationEntity)
    private readonly applications: Repository<JobApplicationEntity>,
    @InjectRepository(JobApplicationStatusEventEntity)
    private readonly events: Repository<JobApplicationStatusEventEntity>,
    @InjectRepository(JobEntity) private readonly jobs: Repository<JobEntity>,
    @InjectRepository(BusinessProfileEntity)
    private readonly profiles: Repository<BusinessProfileEntity>,
    private readonly storage: GcsStorageService,
    private readonly dataSource: DataSource,
    private readonly maintenance: BusinessJobsMaintenanceService,
  ) {}

  async listForJob(userId: string, jobId: string, query: ListApplicationsQueryDto) {
    await this.requireOwnedJob(userId, jobId);
    const take = Math.min(Math.max(query.limit, 1), 100);
    const where = {
      jobId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.search?.trim() ? { candidateName: ILike(`%${query.search.trim()}%`) } : {}),
    };
    const order: FindOptionsOrder<JobApplicationEntity> =
      query.sort === 'OLDEST'
        ? { submittedAt: 'ASC' }
        : query.sort === 'MATCH_DESC'
          ? { matchScore: 'DESC', submittedAt: 'DESC' }
          : { submittedAt: 'DESC' };
    const [items, total] = await this.applications.findAndCount({
      where,
      order,
      skip: (Math.max(query.page, 1) - 1) * take,
      take,
    });
    return { items: items.map(safeApplication), total, page: Math.max(query.page, 1), limit: take };
  }

  async getApplication(userId: string, applicationId: string) {
    const application = await this.requireOwnedApplication(userId, applicationId);
    if (!application.firstViewedAt) {
      application.firstViewedAt = new Date();
      await this.applications.save(application);
    }
    const events = await this.events.find({
      where: { applicationId },
      order: { createdAt: 'ASC' },
    });
    return { application: safeApplication(application), events };
  }

  async downloadCv(
    userId: string,
    applicationId: string,
  ): Promise<{ application: JobApplicationEntity; file: DownloadedFile }> {
    const application = await this.requireOwnedApplication(userId, applicationId);
    if (!application.cvStorageObjectKey || application.piiPurgedAt) {
      throw new NotFoundException({
        errorCode: 'NOT_FOUND',
        message: 'Application CV snapshot is no longer available',
      });
    }
    return { application, file: await this.storage.download(application.cvStorageObjectKey) };
  }

  async updateStatus(userId: string, applicationId: string, input: UpdateApplicationStatusDto) {
    await this.requireOwnedApplication(userId, applicationId);
    const now = new Date();
    let notificationEventId: string | null = null;
    const result = await this.dataSource.transaction(async (manager) => {
      const applications = manager.getRepository(JobApplicationEntity);
      const events = manager.getRepository(JobApplicationStatusEventEntity);
      const application = await applications.findOne({
        where: { id: applicationId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!application) throw this.applicationNotFound();
      if (application.status !== input.expectedStatus) {
        throw new ConflictException({
          errorCode: 'INVALID_APPLICATION_STATUS_TRANSITION',
          message: `Application status changed from expected ${input.expectedStatus}`,
        });
      }
      assertApplicationTransition(application.status, input.status);
      const fromStatus = application.status;
      application.status = input.status;
      if (input.status === 'REJECTED') {
        application.terminalAt = now;
        application.piiPurgeAfter = retentionDateForApplication({
          status: 'REJECTED',
          terminalAt: now,
          jobEndedAt: null,
        });
      }
      await applications.save(application);
      const event = await events.save(
        events.create({
          applicationId: application.id,
          fromStatus,
          toStatus: input.status,
          actorUserId: userId,
          internalNote: input.internalNote?.trim() || null,
          notificationType: 'APPLICATION_STATUS_CHANGED',
          notificationStatus: 'PENDING',
          notificationAttemptCount: 0,
          notificationNextAttemptAt: now,
        }),
      );
      notificationEventId = event.id;
      return application;
    });
    if (notificationEventId) {
      await this.maintenance.processNotificationEvent(notificationEventId).catch(() => false);
    }
    return safeApplication(result);
  }

  private async requireOwnedApplication(userId: string, applicationId: string) {
    const application = await this.applications.findOne({ where: { id: applicationId } });
    if (!application) throw this.applicationNotFound();
    await this.requireOwnedJob(userId, application.jobId);
    return application;
  }

  private async requireOwnedJob(userId: string, jobId: string): Promise<JobEntity> {
    const profile = await this.profiles.findOne({ where: { userId } });
    if (!profile)
      throw new NotFoundException({
        errorCode: 'BUSINESS_PROFILE_NOT_FOUND',
        message: 'Business profile not found',
      });
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

  private applicationNotFound(): NotFoundException {
    return new NotFoundException({
      errorCode: 'JOB_APPLICATION_NOT_FOUND',
      message: 'Job application not found',
    });
  }
}

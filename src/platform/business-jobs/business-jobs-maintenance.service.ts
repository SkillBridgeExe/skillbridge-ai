import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, LessThanOrEqual, Repository } from 'typeorm';
import { BusinessProfileEntity } from '../../database/entities/business-profile.entity';
import { JobApplicationStatusEventEntity } from '../../database/entities/job-application-status-event.entity';
import { JobApplicationEntity } from '../../database/entities/job-application.entity';
import { JobEntity } from '../../database/entities/job.entity';
import { EmailService } from '../../infrastructure/email/email.service';
import { GcsStorageService } from '../../infrastructure/storage/gcs-storage.service';

@Injectable()
export class BusinessJobsMaintenanceService {
  constructor(
    @InjectRepository(JobApplicationStatusEventEntity)
    private readonly events: Repository<JobApplicationStatusEventEntity>,
    @InjectRepository(JobApplicationEntity)
    private readonly applications: Repository<JobApplicationEntity>,
    @InjectRepository(JobEntity) private readonly jobs: Repository<JobEntity>,
    @InjectRepository(BusinessProfileEntity)
    private readonly profiles: Repository<BusinessProfileEntity>,
    private readonly email: EmailService,
    private readonly storage: GcsStorageService,
    private readonly dataSource: DataSource,
  ) {}

  async processPendingNotifications(now = new Date(), limit = 100): Promise<number> {
    const ids = await this.claimDueNotifications(now, Math.min(Math.max(limit, 1), 500));
    const events = ids.length ? await this.events.find({ where: { id: In(ids) } }) : [];
    let sent = 0;
    for (const event of events) {
      if (await this.deliverNotification(event, now)) sent += 1;
    }
    return sent;
  }

  async processNotificationEvent(eventId: string, now = new Date()): Promise<boolean> {
    const claimed = await this.claimNotificationEvent(eventId, now);
    if (!claimed) return false;
    const event = await this.events.findOne({ where: { id: eventId } });
    if (!event) return false;
    return this.deliverNotification(event, now);
  }

  async expireDueEmployerJobs(now = new Date()): Promise<number> {
    const rows = await this.dataSource.query<Array<{ id: string }>>(
      `UPDATE public.jobs
          SET status = 'expired', updated_at = now()
        WHERE source_type = 'employer'
          AND status = 'active'
          AND expires_at IS NOT NULL
          AND expires_at <= $1
      RETURNING id`,
      [now.toISOString()],
    );
    return rows.length;
  }

  async scheduleEndedJobRetention(): Promise<number> {
    const rows = await this.dataSource.query<Array<{ id: string }>>(
      `UPDATE public.job_applications a
          SET pii_purge_after = COALESCE(
                a.pii_purge_after,
                COALESCE(j.closed_at, j.removed_at, j.expires_at) + interval '90 days'
              ),
              updated_at = now()
         FROM public.jobs j
        WHERE a.job_id = j.id
          AND a.pii_purged_at IS NULL
          AND a.status NOT IN ('REJECTED', 'WITHDRAWN')
          AND j.status IN ('closed', 'expired', 'removed')
          AND COALESCE(j.closed_at, j.removed_at, j.expires_at) IS NOT NULL
          AND a.pii_purge_after IS NULL
       RETURNING a.id`,
    );
    return rows.length;
  }

  async purgeDueApplicationPii(now = new Date()): Promise<number> {
    const due = await this.applications.find({
      where: { piiPurgeAfter: LessThanOrEqual(now), piiPurgedAt: IsNull() },
      take: 500,
    });
    let purged = 0;
    for (const application of due) {
      if (application.cvStorageObjectKey) {
        try {
          await this.storage.delete(application.cvStorageObjectKey);
        } catch {
          continue;
        }
      }
      application.candidateName = '[purged]';
      application.candidateEmail = '[purged]';
      application.candidatePhone = null;
      application.coverNote = null;
      application.cvStorageObjectKey = null;
      application.cvOriginalFileName = null;
      application.cvContentType = null;
      application.cvFileSize = null;
      application.cvChecksumSha256 = null;
      application.cvSkillsSnapshot = [];
      application.sourceCvId = null;
      application.piiPurgedAt = now;
      await this.applications.save(application);
      purged += 1;
    }
    return purged;
  }

  private async notificationMessage(
    event: JobApplicationStatusEventEntity,
    application: JobApplicationEntity,
  ) {
    if (event.notificationType === 'NEW_APPLICATION') {
      const job = await this.jobs.findOne({ where: { id: application.jobId } });
      if (!job) throw new Error('JOB_RECIPIENT_UNAVAILABLE');
      const profile = await this.profiles.findOne({ where: { companyId: job.companyId } });
      if (!profile?.workEmailNormalized) throw new Error('BUSINESS_RECIPIENT_UNAVAILABLE');
      const subject = `New application for ${job.title}`;
      const text = `A candidate submitted an application for ${job.title}. Open the SkillBridge business dashboard to review it.`;
      return { to: profile.workEmailNormalized, subject, text, html: `<p>${escapeHtml(text)}</p>` };
    }
    const subject = `Your SkillBridge application is now ${event.toStatus}`;
    const text = `Your application status changed to ${event.toStatus}. Open My Applications in SkillBridge for details.`;
    return { to: application.candidateEmail, subject, text, html: `<p>${escapeHtml(text)}</p>` };
  }

  private async claimDueNotifications(now: Date, limit: number): Promise<string[]> {
    const leaseUntil = new Date(now.getTime() + 5 * 60 * 1000);
    const rows = await this.dataSource.query<Array<{ id: string }>>(
      `WITH due AS (
         SELECT id
           FROM public.job_application_status_events
          WHERE notification_status IN ('PENDING', 'FAILED')
            AND notification_next_attempt_at <= $1
          ORDER BY created_at
          FOR UPDATE SKIP LOCKED
          LIMIT $2
       )
       UPDATE public.job_application_status_events event
          SET notification_next_attempt_at = $3
         FROM due
        WHERE event.id = due.id
      RETURNING event.id`,
      [now.toISOString(), limit, leaseUntil.toISOString()],
    );
    return rows.map((row) => row.id);
  }

  private async claimNotificationEvent(eventId: string, now: Date): Promise<boolean> {
    const leaseUntil = new Date(now.getTime() + 5 * 60 * 1000);
    const rows = await this.dataSource.query<Array<{ id: string }>>(
      `UPDATE public.job_application_status_events
          SET notification_next_attempt_at = $3
        WHERE id = $1
          AND notification_status IN ('PENDING', 'FAILED')
          AND (notification_next_attempt_at IS NULL OR notification_next_attempt_at <= $2)
      RETURNING id`,
      [eventId, now.toISOString(), leaseUntil.toISOString()],
    );
    return rows.length === 1;
  }

  private async deliverNotification(
    event: JobApplicationStatusEventEntity,
    now: Date,
  ): Promise<boolean> {
    try {
      const application = await this.applications.findOne({ where: { id: event.applicationId } });
      if (!application || application.piiPurgedAt)
        throw new Error('APPLICATION_RECIPIENT_UNAVAILABLE');
      const message = await this.notificationMessage(event, application);
      await this.email.sendTransactionalEmail(
        message.to,
        message.subject,
        message.html,
        message.text,
      );
      event.notificationStatus = 'SENT';
      event.notificationSentAt = now;
      event.notificationErrorCode = null;
      event.notificationNextAttemptAt = null;
      await this.events.save(event);
      return true;
    } catch (error) {
      event.notificationStatus = 'FAILED';
      event.notificationAttemptCount += 1;
      event.notificationErrorCode = notificationErrorCode(error);
      event.notificationNextAttemptAt = new Date(
        now.getTime() +
          Math.min(24, 2 ** Math.min(event.notificationAttemptCount, 5)) * 60 * 60 * 1000,
      );
      await this.events.save(event);
      return false;
    }
  }
}

function notificationErrorCode(error: unknown): string {
  if (typeof error === 'object' && error && 'response' in error) {
    const response = (error as { response?: { errorCode?: string } }).response;
    if (response?.errorCode) return response.errorCode;
  }
  if (error instanceof Error && /^[A-Z_]+$/.test(error.message)) return error.message;
  return 'EMAIL_SEND_FAILED';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

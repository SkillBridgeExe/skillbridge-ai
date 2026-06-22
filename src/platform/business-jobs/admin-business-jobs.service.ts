import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import {
  BusinessProfileEntity,
  BusinessProfileStatus,
} from '../../database/entities/business-profile.entity';
import { JobReportEntity, JobReportStatus } from '../../database/entities/job-report.entity';
import { JobEntity } from '../../database/entities/job.entity';

@Injectable()
export class AdminBusinessJobsService {
  constructor(
    @InjectRepository(JobEntity) private readonly jobs: Repository<JobEntity>,
    @InjectRepository(JobReportEntity) private readonly reports: Repository<JobReportEntity>,
    private readonly dataSource: DataSource,
  ) {}

  async updateBusinessStatus(
    actorUserId: string,
    profileId: string,
    status: Extract<BusinessProfileStatus, 'VERIFIED' | 'REJECTED' | 'SUSPENDED'>,
    reason?: string,
  ) {
    if ((status === 'REJECTED' || status === 'SUSPENDED') && !reason?.trim()) {
      throw new BadRequestException({
        errorCode: 'VALIDATION_ERROR',
        message: 'reason is required',
      });
    }
    return this.dataSource.transaction(async (manager) => {
      const profiles = manager.getRepository(BusinessProfileEntity);
      const jobs = manager.getRepository(JobEntity);
      const profile = await profiles.findOne({
        where: { id: profileId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!profile)
        throw new NotFoundException({
          errorCode: 'BUSINESS_PROFILE_NOT_FOUND',
          message: 'Business profile not found',
        });
      const now = new Date();
      profile.status = status;
      profile.reviewedAt = now;
      profile.reviewedByUserId = actorUserId;
      profile.rejectionReason = status === 'REJECTED' ? reason!.trim() : null;
      profile.suspensionReason = status === 'SUSPENDED' ? reason!.trim() : null;
      const updated = await profiles.save(profile);
      if (status === 'SUSPENDED') {
        const activeJobs = await jobs.find({
          where: { companyId: profile.companyId, sourceType: 'employer', status: 'active' },
        });
        for (const job of activeJobs) {
          job.status = 'removed';
          job.removedAt = now;
          job.removedByUserId = actorUserId;
          job.removalReason = reason!.trim();
        }
        if (activeJobs.length) await jobs.save(activeJobs);
      }
      return updated;
    });
  }

  async listReports(status?: JobReportStatus, page = 1, limit = 20) {
    const take = Math.min(Math.max(limit, 1), 100);
    const [items, total] = await this.reports.findAndCount({
      where: status ? { status } : {},
      order: { createdAt: 'DESC' },
      skip: (Math.max(page, 1) - 1) * take,
      take,
    });
    return { items, total, page: Math.max(page, 1), limit: take };
  }

  async resolveReport(
    actorUserId: string,
    reportId: string,
    status: Extract<JobReportStatus, 'DISMISSED' | 'ACTIONED'>,
    note?: string,
  ) {
    const report = await this.reports.findOne({ where: { id: reportId } });
    if (!report) throw new NotFoundException('Job report not found');
    report.status = status;
    report.resolvedByUserId = actorUserId;
    report.resolutionNote = note?.trim() || null;
    report.resolvedAt = new Date();
    return this.reports.save(report);
  }

  async getJob(jobId: string) {
    const job = await this.jobs.findOne({ where: { id: jobId } });
    if (!job) throw new NotFoundException({ errorCode: 'JOB_NOT_FOUND', message: 'Job not found' });
    return job;
  }

  async removeJob(actorUserId: string, jobId: string, reason: string) {
    if (!reason.trim())
      throw new BadRequestException({
        errorCode: 'VALIDATION_ERROR',
        message: 'reason is required',
      });
    const job = await this.getJob(jobId);
    job.status = 'removed';
    job.removedAt = new Date();
    job.removedByUserId = actorUserId;
    job.removalReason = reason.trim();
    return this.jobs.save(job);
  }
}

import { getMetadataArgsStorage } from 'typeorm';
import { BusinessProfileEntity } from './business-profile.entity';
import { CompanyEntity } from './company.entity';
import { JobApplicationEntity } from './job-application.entity';
import { JobApplicationStatusEventEntity } from './job-application-status-event.entity';
import { JobPostVersionEntity } from './job-post-version.entity';
import { JobReportEntity } from './job-report.entity';
import { JobEntity } from './job.entity';
import { SavedJobEntity } from './saved-job.entity';

describe('business jobs entity mappings', () => {
  it.each([
    [CompanyEntity, 'companies'],
    [JobEntity, 'jobs'],
    [BusinessProfileEntity, 'business_profiles'],
    [JobPostVersionEntity, 'job_post_versions'],
    [SavedJobEntity, 'saved_jobs'],
    [JobApplicationEntity, 'job_applications'],
    [JobApplicationStatusEventEntity, 'job_application_status_events'],
    [JobReportEntity, 'job_reports'],
  ])('maps %p to %s', (target, expectedName) => {
    const table = getMetadataArgsStorage().tables.find((item) => item.target === target);
    expect(table?.name).toBe(expectedName);
  });
});

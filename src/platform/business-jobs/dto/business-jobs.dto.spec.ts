import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ApplyToJobDto,
  BusinessJobsQueryDto,
  JobLocationDto,
  UpdateApplicationStatusDto,
} from './business-jobs.dto';

describe('business jobs DTO validation', () => {
  it('rejects an application without explicit consent', async () => {
    const dto = plainToInstance(ApplyToJobDto, {
      jobVersionId: '2e70835a-61d6-44f0-8f67-2fdb80c4078a',
      cvId: 'fe81506b-9f6a-49a8-9b98-b65771c47625',
      candidateName: 'Candidate',
      candidateEmail: 'candidate@example.com',
      consentAccepted: false,
      consentVersion: 'job-apply-v1',
    });
    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'consentAccepted')).toBe(true);
  });

  it('rejects BUSINESS attempts to set SUBMITTED directly', async () => {
    const dto = plainToInstance(UpdateApplicationStatusDto, {
      expectedStatus: 'IN_REVIEW',
      status: 'SUBMITTED',
    });
    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'status')).toBe(true);
  });

  it('allows an address-free job location', async () => {
    const dto = plainToInstance(JobLocationDto, {
      cityCode: 'HCM',
      countryCode: 'VN',
      isPrimary: true,
    });
    expect(await validate(dto)).toEqual([]);
  });

  it('accepts optional district metadata for a precise workplace location', async () => {
    const dto = plainToInstance(JobLocationDto, {
      cityCode: 'HCM',
      countryCode: 'VN',
      districtCode: 'THU_DUC',
      districtName: 'Thành phố Thủ Đức',
      addressLine: 'Khu Công nghệ cao, phường Tăng Nhơn Phú',
      isPrimary: true,
    });

    expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
  });

  it('validates the business job list status, query text, and pagination', async () => {
    const valid = plainToInstance(BusinessJobsQueryDto, {
      status: 'active',
      q: 'backend',
      page: '2',
      limit: '50',
    });
    expect(await validate(valid)).toEqual([]);
    expect(valid.page).toBe(2);
    expect(valid.limit).toBe(50);

    const invalid = plainToInstance(BusinessJobsQueryDto, {
      status: 'published',
      q: 'x'.repeat(256),
      page: '0',
      limit: '101',
    });
    const errors = await validate(invalid);
    expect(errors.map((error) => error.property)).toEqual(
      expect.arrayContaining(['status', 'q', 'page', 'limit']),
    );
  });
});

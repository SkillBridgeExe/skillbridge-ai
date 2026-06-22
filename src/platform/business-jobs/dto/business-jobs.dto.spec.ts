import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ApplyToJobDto, UpdateApplicationStatusDto } from './business-jobs.dto';

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
});

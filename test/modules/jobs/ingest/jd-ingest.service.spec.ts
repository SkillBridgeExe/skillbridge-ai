import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  JdIngestService,
  RawJobInput,
} from '../../../../src/modules/jobs/ingest/jd-ingest.service';
import { DatabaseService } from '../../../../src/infrastructure/database/database.service';
import { LlmService } from '../../../../src/infrastructure/llm/llm.service';
import { SkillTextScannerService } from '../../../../src/common/services/skill-text-scanner.service';
import { SkillTaxonomyService } from '../../../../src/common/services/skill-taxonomy.service';

interface MockDbClient {
  query: jest.Mock;
}

describe('JdIngestService (integration/unit)', () => {
  let service: JdIngestService;
  let dbMock: { query: jest.Mock; transaction: jest.Mock };
  let mockClient: MockDbClient;
  let scannerMock: { scan: jest.Mock };

  beforeEach(async () => {
    mockClient = {
      query: jest.fn().mockImplementation((sql: string) => {
        if (sql.includes('INSERT INTO public.jobs')) {
          return { rows: [{ id: 'mock-job-id', is_new: true }] };
        }
        if (sql.includes('UPDATE public.jobs SET canonical_job_id')) {
          return { rows: [] };
        }
        if (sql.includes('DELETE FROM public.job_skills')) {
          return { rows: [] };
        }
        if (sql.includes('SELECT id FROM public.skills')) {
          return { rows: [{ id: 'mock-skill-id' }] };
        }
        return { rows: [] };
      }),
    };

    dbMock = {
      query: jest.fn().mockResolvedValue([{ id: 'mock-run-id' }]),
      transaction: jest
        .fn()
        .mockImplementation(async (cb: (c: MockDbClient) => Promise<unknown>) => cb(mockClient)),
    };

    scannerMock = {
      scan: jest.fn().mockReturnValue([{ canonical_name: 'nodejs', matched_text: 'NodeJS' }]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JdIngestService,
        { provide: DatabaseService, useValue: dbMock },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: LlmService, useValue: { embed: jest.fn() } },
        { provide: SkillTextScannerService, useValue: scannerMock },
        { provide: SkillTaxonomyService, useValue: { getByCanonical: jest.fn() } },
      ],
    }).compile();

    service = module.get<JdIngestService>(JdIngestService);
  });

  it('wires location and work_mode correctly into INSERT, preserving existing metadata on conflict', async () => {
    const rawJob: RawJobInput = {
      source_type: 'employer',
      source_name: 'test-source',
      title: 'Backend Developer (Remote)',
      company_name: 'Test Co',
      location: 'Ho Chi Minh City',
      jd_text: 'NodeJS',
    };

    await service.ingestBatch([rawJob]);

    expect(dbMock.transaction).toHaveBeenCalled();

    // Find the call for the jobs INSERT
    const insertCall = mockClient.query.mock.calls.find((call) =>
      (call[0] as string).includes('INSERT INTO public.jobs'),
    );
    expect(insertCall).toBeDefined();

    const sql = insertCall[0] as string;
    const params = insertCall[1] as unknown[];

    // Ensure UPSERT handles metadata safely to prevent data loss when classifier returns null
    expect(sql).toContain(
      'primary_city_code = COALESCE(EXCLUDED.primary_city_code, jobs.primary_city_code)',
    );
    expect(sql).toContain(
      'location_city_codes = CASE WHEN COALESCE(cardinality(EXCLUDED.location_city_codes), 0) > 0 THEN EXCLUDED.location_city_codes ELSE jobs.location_city_codes END',
    );
    expect(sql).toContain('work_mode = COALESCE(EXCLUDED.work_mode, jobs.work_mode)');

    // Verify params mapping
    // $2=title, $4=location, $5=locations, $6=primary_city_code, $7=location_city_codes, $8=work_mode
    expect(params[1]).toBe('Backend Developer (Remote)');
    expect(params[3]).toBe('Ho Chi Minh City');
    expect(JSON.parse(params[4] as string)).toEqual([
      expect.objectContaining({ cityCode: 'HCM', granularity: 'city', isPrimary: true }),
    ]);
    expect(params[5]).toBe('HCM');
    expect(params[6]).toEqual(['HCM']);
    expect(params[7]).toBe('REMOTE');
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JdIngestService, RawJobInput } from '../../../../src/modules/jobs/ingest/jd-ingest.service';
import { DatabaseService } from '../../../../src/infrastructure/database/database.service';
import { LlmService } from '../../../../src/infrastructure/llm/llm.service';
import { SkillTextScannerService } from '../../../../src/common/services/skill-text-scanner.service';
import { SkillTaxonomyService } from '../../../../src/common/services/skill-taxonomy.service';

describe('JdIngestService (integration/unit)', () => {
  let service: JdIngestService;
  let dbMock: any;

  beforeEach(async () => {
    dbMock = {
      query: jest.fn().mockResolvedValue([{ id: 'mock-run-id' }]),
      transaction: jest.fn().mockImplementation(async (cb: any) => {
        const client = {
          query: jest.fn().mockImplementation((sql: string, params: any[]) => {
            if (sql.includes('INSERT INTO public.jobs')) {
              // Store the params so we can assert on them
              dbMock.lastInsertParams = params;
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
        return cb(client);
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JdIngestService,
        { provide: DatabaseService, useValue: dbMock },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: LlmService, useValue: { embed: jest.fn() } },
        {
          provide: SkillTextScannerService,
          useValue: { scan: jest.fn().mockReturnValue([]) },
        },
        {
          provide: SkillTaxonomyService,
          useValue: { getByCanonical: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<JdIngestService>(JdIngestService);
  });

  it('wires location_city_codes, primary_city_code, and work_mode correctly into INSERT', async () => {
    const rawJob: RawJobInput = {
      source_type: 'employer',
      source_name: 'test-source',
      title: 'Backend Developer (Remote)',
      company_name: 'Test Co',
      location: 'Ho Chi Minh City',
      jd_text: 'NodeJS, React',
      work_mode: undefined, // rely on classifier
    };

    // To prevent skipped_no_skills, we must ensure scan returns at least one skill.
    // The test mock returns [] for scan, which would cause the service to return 'skipped_no_skills' early.
    const scanner = service['scanner'] as any;
    scanner.scan.mockReturnValue([{ canonical_name: 'nodejs', matched_text: 'NodeJS' }]);

    await service.ingestBatch([rawJob]);

    // Check that we called db.transaction
    expect(dbMock.transaction).toHaveBeenCalled();

    // Check the captured INSERT params
    // Parameters in our SQL (19 columns): 
    // $1=companyId, $2=title, $3=roleCode, $4=location, $5=primary_city_code, $6=location_city_codes, $7=work_mode
    const insertParams = dbMock.lastInsertParams;
    expect(insertParams).toBeDefined();
    
    // Check title ($2)
    expect(insertParams[1]).toBe('Backend Developer (Remote)');
    // Check location ($4)
    expect(insertParams[3]).toBe('Ho Chi Minh City');
    // Check primary_city_code ($5) -> HCM
    expect(insertParams[4]).toBe('HCM');
    // Check location_city_codes ($6) -> ['HCM']
    expect(insertParams[5]).toEqual(['HCM']);
    // Check work_mode ($7) -> REMOTE (derived from title)
    expect(insertParams[6]).toBe('REMOTE');
  });
});

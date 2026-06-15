import { CvJdMatchExtractionCacheService } from '../../../src/modules/cv-jd-match/cv-jd-match-extraction-cache.service';
import { RoleRubricService } from '../../../src/common/services/role-rubric.service';
import { SkillNormalizerService } from '../../../src/common/services/skill-normalizer.service';
import { SkillTaxonomyService } from '../../../src/common/services/skill-taxonomy.service';
import { SkillDiffService } from '../../../src/modules/cv-jd-match/skill-diff.service';

const extraction = {
  cv_skills_raw: [
    {
      name: 'React',
      proficiency_hint: 'ADVANCED',
      evidence_text: 'Built dashboards for jane.doe@example.com, phone 0901234567',
    },
  ],
  jd_requirements_raw: [
    {
      name: 'React',
      importance: 'REQUIRED',
      evidence_text: 'We require React for customer dashboard work',
    },
  ],
  jd_dimensions_raw: [],
  jd_dimensions: [],
};

const enabledConfig = {
  get: jest.fn((key: string) => (key === 'cvJdMatch.extractionCacheEnabled' ? true : undefined)),
};

const disabledConfig = {
  get: jest.fn((key: string) => (key === 'cvJdMatch.extractionCacheEnabled' ? false : undefined)),
};

const buildRepo = () => {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    rows,
    repo: {
      findOne: jest.fn(async ({ where }: { where: { cacheKey: string } }) => {
        return rows.get(where.cacheKey) ?? null;
      }),
      upsert: jest.fn(async (row: Record<string, unknown>) => {
        rows.set(row.cacheKey as string, { ...row });
        return { identifiers: [{ cacheKey: row.cacheKey }] };
      }),
      increment: jest.fn(async ({ cacheKey }: { cacheKey: string }, field: string, by: number) => {
        const row = rows.get(cacheKey);
        if (row) {
          row[field] = Number(row[field] ?? 0) + by;
        }
        return { affected: row ? 1 : 0 };
      }),
      update: jest.fn(
        async ({ cacheKey }: { cacheKey: string }, patch: Record<string, unknown>) => {
          const row = rows.get(cacheKey);
          if (row) {
            Object.assign(row, patch);
          }
          return { affected: row ? 1 : 0 };
        },
      ),
    },
  };
};

describe('CvJdMatchExtractionCacheService', () => {
  let diff: SkillDiffService;

  beforeAll(async () => {
    const taxonomy = new SkillTaxonomyService();
    await taxonomy.onModuleInit();
    const normalizer = new SkillNormalizerService(taxonomy);
    const rubrics = new RoleRubricService();
    await rubrics.onModuleInit();
    diff = new SkillDiffService(normalizer, rubrics);
  });

  it('builds stable keys for whitespace-normalized equivalent text', () => {
    const service = new CvJdMatchExtractionCacheService(enabledConfig as never);

    const a = service.hashKey({
      cvText: '  React developer\r\nwith TypeScript   \n',
      jdText: 'Requires React\r\nand TypeScript\t ',
      templateCode: 'cv_jd_match_v1',
      provider: 'openai',
      modelCode: 'gpt-5.4-mini',
    });
    const b = service.hashKey({
      cvText: 'React developer\nwith TypeScript',
      jdText: 'Requires React\nand TypeScript',
      templateCode: 'cv_jd_match_v1',
      provider: 'openai',
      modelCode: 'gpt-5.4-mini',
    });

    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('invalidates when template or model changes', () => {
    const service = new CvJdMatchExtractionCacheService(enabledConfig as never);
    const base = {
      cvText: 'React developer',
      jdText: 'Requires React',
      templateCode: 'cv_jd_match_v1',
      provider: 'openai',
      modelCode: 'gpt-5.4-mini',
    };

    expect(service.hashKey(base)).not.toBe(
      service.hashKey({ ...base, templateCode: 'cv_jd_match_v2' }),
    );
    expect(service.hashKey(base)).not.toBe(service.hashKey({ ...base, modelCode: 'gpt-5.4' }));
  });

  it('is no-op when disabled or repository is absent', async () => {
    const { repo } = buildRepo();
    const disabled = new CvJdMatchExtractionCacheService(disabledConfig as never, repo as never);
    const noRepo = new CvJdMatchExtractionCacheService(enabledConfig as never);

    await disabled.write('a'.repeat(64), extraction, {
      provider: 'openai',
      modelCode: 'gpt-5.4-mini',
      templateCode: 'cv_jd_match_v1',
      promptTemplateVersion: 1,
    });
    await noRepo.write('b'.repeat(64), extraction, {
      provider: 'openai',
      modelCode: 'gpt-5.4-mini',
      templateCode: 'cv_jd_match_v1',
      promptTemplateVersion: 1,
    });

    expect(await disabled.read('a'.repeat(64))).toBeNull();
    expect(await noRepo.read('b'.repeat(64))).toBeNull();
    expect(repo.upsert).not.toHaveBeenCalled();
  });

  it('writes a PII-masked payload, reads it back, and records hits separately', async () => {
    const { repo, rows } = buildRepo();
    const service = new CvJdMatchExtractionCacheService(enabledConfig as never, repo as never);
    const cacheKey = service.hashKey({
      cvText: 'React developer',
      jdText: 'Requires React',
      templateCode: 'cv_jd_match_v1',
      provider: 'openai',
      modelCode: 'gpt-5.4-mini',
    });

    await service.write(cacheKey, extraction, {
      provider: 'openai',
      modelCode: 'gpt-5.4-mini',
      templateCode: 'cv_jd_match_v1',
      promptTemplateVersion: 1,
    });

    const row = rows.get(cacheKey);
    expect(row).toMatchObject({
      cacheKey,
      provider: 'openai',
      modelCode: 'gpt-5.4-mini',
      templateCode: 'cv_jd_match_v1',
      promptTemplateVersion: 1,
    });
    expect(JSON.stringify(row?.payload)).not.toContain('jane.doe@example.com');
    expect(JSON.stringify(row?.payload)).not.toContain('0901234567');
    expect(JSON.stringify(row?.payload)).toContain('[redacted-email]');

    await expect(service.read(cacheKey)).resolves.toEqual({
      ...(row?.payload as object),
      jd_dimensions: [],
    });
    await service.recordHit(cacheKey);

    expect(repo.increment).toHaveBeenCalledWith({ cacheKey }, 'hitCount', 1);
    expect(repo.update).toHaveBeenCalledWith(
      { cacheKey },
      expect.objectContaining({ lastHitAt: expect.any(Date) }),
    );
  });

  it('stores jd_dimensions_raw and normalizes dimensions on read instead of freezing parser output', async () => {
    const { repo } = buildRepo();
    const service = new CvJdMatchExtractionCacheService(enabledConfig as never, repo as never);
    const cacheKey = 'c'.repeat(64);

    await service.write(
      cacheKey,
      {
        ...extraction,
        jd_dimensions_raw: [
          {
            dimension: 'language',
            value_text: 'English B2',
            level_hint: 'B2',
            importance_hint: 'REQUIRED',
            evidence_text: 'English B2 required',
          },
          { dimension: 'language', level_hint: 'C1' }, // no evidence_text -> dropped on read
        ],
      },
      {
        provider: 'openai',
        modelCode: 'gpt-5.4-mini',
        templateCode: 'cv_jd_match_v2',
        promptTemplateVersion: 2,
      },
    );

    const hit = await service.read(cacheKey);

    expect(hit?.jd_dimensions_raw).toHaveLength(2);
    expect(hit?.jd_dimensions).toEqual([
      expect.objectContaining({
        dimension: 'language',
        level_hint: 'B2',
        importance: 'REQUIRED',
        evidence_text: 'English B2 required',
      }),
    ]);
  });

  it('masked cache payload keeps hit and miss scoring identical', async () => {
    const { repo } = buildRepo();
    const service = new CvJdMatchExtractionCacheService(enabledConfig as never, repo as never);
    const cacheKey = 'd'.repeat(64);
    const original = {
      cv_skills_raw: [
        {
          name: 'React',
          proficiency_hint: 'ADVANCED',
          evidence_text: 'Built React dashboards for jane.doe@example.com, phone 0901234567',
        },
        {
          name: 'TypeScript',
          proficiency_hint: 'INTERMEDIATE',
          evidence_text: 'Migrated forms to TypeScript for customer 0907654321',
        },
      ],
      jd_requirements_raw: [
        {
          name: 'React',
          required_level_hint: 'INTERMEDIATE',
          importance_hint: 'REQUIRED',
          evidence_text: 'React is required',
        },
        {
          name: 'TypeScript',
          required_level_hint: 'INTERMEDIATE',
          importance_hint: 'REQUIRED',
          evidence_text: 'TypeScript is required',
        },
      ],
      jd_dimensions_raw: [],
      jd_dimensions: [],
    };

    const missScore = diff.diff({
      cv_skills_raw: original.cv_skills_raw,
      jd_requirements_raw: original.jd_requirements_raw,
      target_band: 'fresher',
    });

    await service.write(cacheKey, original, {
      provider: 'openai',
      modelCode: 'gpt-5.4-mini',
      templateCode: 'cv_jd_match_v1',
      promptTemplateVersion: 1,
    });
    const hit = await service.read(cacheKey);
    expect(JSON.stringify(hit)).not.toContain('jane.doe@example.com');
    expect(JSON.stringify(hit)).not.toContain('0901234567');

    const hitScore = diff.diff({
      cv_skills_raw: hit!.cv_skills_raw,
      jd_requirements_raw: hit!.jd_requirements_raw,
      target_band: 'fresher',
    });

    expect(hitScore.overall_score).toBe(missScore.overall_score);
    expect(hitScore.matched_skills).toEqual(missScore.matched_skills);
    expect(hitScore.partial_skills).toEqual(missScore.partial_skills);
    expect(hitScore.missing_skills).toEqual(missScore.missing_skills);
  });
});

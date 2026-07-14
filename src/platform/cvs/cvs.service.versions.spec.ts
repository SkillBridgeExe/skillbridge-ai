import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CvEntity } from '../../database/entities/cv.entity';
import { CvSkillEntity } from '../../database/entities/cv-skill.entity';
import { SkillEntity } from '../../database/entities/skill.entity';
import { CvsService } from './cvs.service';

/**
 * CV version snapshots (create/list/get/restore) for the builder. Restore must auto-snapshot the
 * current doc first (undoable) then overwrite parsed_json. Ownership-gated; 404 on missing version.
 * Beyond Reactive Resume, which keeps a single blob.
 */
describe('CvsService versions', () => {
  const CV_SKILLS_ARG_INDEX = 1;
  const CV_VERSIONS_ARG_INDEX = 23; // trailing optional constructor param

  function makeCv(overrides: Record<string, unknown> = {}) {
    return {
      id: 'cv-1',
      userId: 'user-1',
      title: 'My CV',
      originalFileName: null,
      fileType: null,
      fileSize: null,
      parsedText: null,
      parsedJson: { language: 'en', skills: {} },
      cvKind: 'BUILT',
      language: 'en',
      targetRole: null,
      isOcrOnly: false,
      atsReadabilityScore: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      deletedAt: null,
      ...overrides,
    };
  }

  function setup(
    cvsRepo: Record<string, jest.Mock>,
    versionsRepo: Record<string, jest.Mock>,
    cvSkillsRepo: Record<string, jest.Mock> = { find: jest.fn().mockResolvedValue([]) },
  ): CvsService {
    const args: unknown[] = new Array(24).fill(undefined);
    args[0] = cvsRepo;
    args[CV_SKILLS_ARG_INDEX] = cvSkillsRepo;
    args[CV_VERSIONS_ARG_INDEX] = versionsRepo;
    return Reflect.construct(CvsService, args) as CvsService;
  }

  it('createVersion snapshots the current doc as MANUAL, trims the label, and prunes autos', async () => {
    const cvsRepo = { findOne: jest.fn().mockResolvedValue(makeCv()) };
    const versionsRepo = {
      create: jest.fn().mockImplementation((x) => x),
      save: jest
        .fn()
        .mockImplementation((x) =>
          Promise.resolve({ ...x, id: 'v1', createdAt: new Date('2026-02-01T00:00:00.000Z') }),
        ),
      find: jest.fn().mockResolvedValue([]),
      delete: jest.fn(),
    };
    const service = setup(cvsRepo, versionsRepo);

    const res = await service.createVersion('user-1', 'cv-1', '  Before tailoring  ');

    expect(versionsRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ cvId: 'cv-1', origin: 'MANUAL', label: 'Before tailoring' }),
    );
    expect(res.id).toBe('v1');
    expect(res.origin).toBe('MANUAL');
    expect(versionsRepo.find).toHaveBeenCalled(); // prune ran
  });

  it('prunes MANUAL versions beyond the cap of 50', async () => {
    const cvsRepo = { findOne: jest.fn().mockResolvedValue(makeCv()) };
    const overflowManual = Array.from({ length: 52 }, (_, i) => ({ id: `m${i}` }));
    const versionsRepo = {
      create: jest.fn().mockImplementation((x) => x),
      save: jest
        .fn()
        .mockImplementation((x) => Promise.resolve({ ...x, id: 'new', createdAt: new Date() })),
      // prune queries auto first (none), then manual (52 → over the 50 cap)
      find: jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(overflowManual),
      delete: jest.fn(),
    };
    const service = setup(cvsRepo, versionsRepo);

    await service.createVersion('user-1', 'cv-1', 'v');

    // auto prune deletes nothing; manual prune deletes exactly the overflow beyond 50
    expect(versionsRepo.delete).toHaveBeenCalledTimes(1);
  });

  it('createVersion accepts AUTO_PRE_IMPORT origin for the pre-import backup', async () => {
    const cvsRepo = { findOne: jest.fn().mockResolvedValue(makeCv()) };
    const versionsRepo = {
      create: jest.fn().mockImplementation((x) => x),
      save: jest
        .fn()
        .mockImplementation((x) =>
          Promise.resolve({ ...x, id: 'v-import', createdAt: new Date() }),
        ),
      find: jest.fn().mockResolvedValue([]),
      delete: jest.fn(),
    };
    const service = setup(cvsRepo, versionsRepo);

    const res = await service.createVersion('user-1', 'cv-1', 'Before import', 'AUTO_PRE_IMPORT');

    expect(versionsRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ origin: 'AUTO_PRE_IMPORT', label: 'Before import' }),
    );
    expect(res.origin).toBe('AUTO_PRE_IMPORT');
  });

  it('createVersion rejects when the CV has no document', async () => {
    const cvsRepo = { findOne: jest.fn().mockResolvedValue(makeCv({ parsedJson: null })) };
    const versionsRepo = { create: jest.fn(), save: jest.fn(), find: jest.fn(), delete: jest.fn() };
    const service = setup(cvsRepo, versionsRepo);

    await expect(service.createVersion('user-1', 'cv-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(versionsRepo.save).not.toHaveBeenCalled();
  });

  it('listVersions returns summaries without snapshot bodies, ownership-gated', async () => {
    const cvsRepo = { findOne: jest.fn().mockResolvedValue(makeCv()) };
    const rows = [
      {
        id: 'v2',
        cvId: 'cv-1',
        label: null,
        origin: 'MANUAL',
        title: 'My CV',
        createdAt: new Date(),
      },
    ];
    const versionsRepo = { findAndCount: jest.fn().mockResolvedValue([rows, 1]) };
    const service = setup(cvsRepo, versionsRepo);

    const res = await service.listVersions('user-1', 'cv-1', 1, 20);

    expect(cvsRepo.findOne).toHaveBeenCalled(); // ownership gate
    expect(res.total).toBe(1);
    expect(res.items[0].id).toBe('v2');
    expect(res.items[0]).not.toHaveProperty('snapshot');
  });

  it('getVersion returns the snapshot; 404 when the version is missing', async () => {
    const cvsRepo = { findOne: jest.fn().mockResolvedValue(makeCv()) };
    const versionRow = {
      id: 'v3',
      cvId: 'cv-1',
      snapshot: { language: 'en', summary: 'snap' },
      title: 'My CV',
      label: null,
      origin: 'MANUAL',
      createdAt: new Date(),
    };

    const okRes = await setup(cvsRepo, {
      findOne: jest.fn().mockResolvedValue(versionRow),
    }).getVersion('user-1', 'cv-1', 'v3');
    expect(okRes.snapshot).toEqual({ language: 'en', summary: 'snap' });

    await expect(
      setup(cvsRepo, { findOne: jest.fn().mockResolvedValue(null) }).getVersion(
        'user-1',
        'cv-1',
        'nope',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('restoreVersion re-reads the CV under a row lock, auto-snapshots, then overwrites — in ONE transaction', async () => {
    const currentDoc = { language: 'en', skills: {}, summary: 'current' };
    const versionDoc = { language: 'en', skills: {}, summary: 'restored' };
    const cv = makeCv({ parsedJson: currentDoc });
    const cvsRepo = { findOne: jest.fn().mockResolvedValue(cv) };
    const versionsRepo: Record<string, jest.Mock> & { manager?: unknown } = {
      findOne: jest.fn().mockResolvedValue({
        id: 'v4',
        cvId: 'cv-1',
        snapshot: versionDoc,
        title: 'My CV',
        label: null,
        origin: 'MANUAL',
        createdAt: new Date(),
      }),
      find: jest.fn().mockResolvedValue([]),
      delete: jest.fn(),
    };
    // the transaction re-reads the CV row (locked) through its own repository
    const cvLockRepo = { findOne: jest.fn().mockResolvedValue(cv) };
    const em = {
      create: jest.fn().mockImplementation((_entity: unknown, x: unknown) => x),
      save: jest.fn().mockImplementation((x: unknown) => Promise.resolve(x)),
      getRepository: jest.fn((entity: unknown) =>
        entity === CvEntity ? cvLockRepo : versionsRepo,
      ),
    };
    const transaction = jest.fn(async (fn: (m: typeof em) => Promise<unknown>) => fn(em));
    versionsRepo.manager = { transaction };
    const service = setup(cvsRepo, versionsRepo);

    const res = await service.restoreVersion('user-1', 'cv-1', 'v4');

    // Snapshot + overwrite committed together — no spurious AUTO row on a failed restore.
    expect(transaction).toHaveBeenCalledTimes(1);
    // the row is re-read INSIDE the tx under a pessimistic lock, so a concurrent autosave can
    // neither interleave nor stale the pre-restore snapshot
    expect(cvLockRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    );
    // captured the CURRENT doc as an undo point before overwriting
    expect(em.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ origin: 'AUTO_PRE_RESTORE' }),
    );
    // doc overwritten with the restored snapshot (deep clone → deep equal)
    expect(cv.parsedJson).toEqual(versionDoc);
    expect(res.parsedJson).toEqual(versionDoc);
    // both writes (snapshot row + restored CV) went through the transaction manager
    expect(em.save).toHaveBeenCalledTimes(2);
  });

  it('restoreVersion 404s on a missing version and never overwrites', async () => {
    const cvsRepo = { findOne: jest.fn().mockResolvedValue(makeCv()), save: jest.fn() };
    const versionsRepo = { findOne: jest.fn().mockResolvedValue(null) };
    const service = setup(cvsRepo, versionsRepo);

    await expect(service.restoreVersion('user-1', 'cv-1', 'nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(cvsRepo.save).not.toHaveBeenCalled();
  });

  it('does not let a stale autosave overwrite cv_skills after a restore', async () => {
    const restoredDoc = { language: 'en', skills: { technical: ['React'] } };
    const staleAutosaveDoc = { language: 'en', skills: { technical: ['Node.js'] } };
    const currentCv = makeCv({ parsedJson: restoredDoc });
    const cvsRepo = { findOne: jest.fn().mockResolvedValue(currentCv) };
    const cvSkillsRepo = {
      find: jest.fn().mockResolvedValue([]),
      delete: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
    };
    const skillsRepo = { find: jest.fn() };
    const versionsRepo: Record<string, jest.Mock> & { manager?: unknown } = {
      findOne: jest.fn(),
    };
    const cvLockRepo = { findOne: jest.fn().mockResolvedValue(currentCv) };
    const em = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === CvEntity) return cvLockRepo;
        if (entity === CvSkillEntity) return cvSkillsRepo;
        if (entity === SkillEntity) return skillsRepo;
        return undefined;
      }),
    };
    (cvsRepo as { manager?: unknown }).manager = { transaction: jest.fn(async (fn) => fn(em)) };

    const service = setup(cvsRepo, versionsRepo, cvSkillsRepo);
    const args = service as unknown as { skillNormalizer?: unknown };
    args.skillNormalizer = { normalizeManyAsync: jest.fn().mockResolvedValue([]) };

    await (
      service as unknown as { syncSkillsFromDoc: (id: string, doc: unknown) => Promise<void> }
    ).syncSkillsFromDoc('cv-1', staleAutosaveDoc);

    expect(cvLockRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    );
    expect(cvSkillsRepo.delete).not.toHaveBeenCalled();
    expect(cvSkillsRepo.save).not.toHaveBeenCalled();
  });
});

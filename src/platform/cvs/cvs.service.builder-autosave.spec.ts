import { CvsService } from './cvs.service';
import { UpdateBuilderCvDto } from './dto/builder-cv.dto';

/**
 * Builder autosave PUT must NOT own the title: rename (PATCH /api/cvs/:id) does. Old cached FE
 * bundles still send `title` on every debounced save — accepting it would silently overwrite a
 * rename. The DTO keeps the field (forbidNonWhitelisted would 400 old clients otherwise), the
 * service ignores it.
 */
describe('CvsService.updateBuilderDraft — title ownership', () => {
  const CV_SKILLS_ARG_INDEX = 1;

  function makeCv(overrides: Record<string, unknown> = {}) {
    return {
      id: 'cv-1',
      userId: 'user-1',
      title: 'Renamed by user',
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

  function setup(cvsRepo: Record<string, jest.Mock>): CvsService {
    const args: unknown[] = new Array(24).fill(undefined);
    args[0] = cvsRepo;
    args[CV_SKILLS_ARG_INDEX] = { find: jest.fn().mockResolvedValue([]) };
    return Reflect.construct(CvsService, args) as CvsService;
  }

  it('ignores dto.title from old clients — the renamed title survives the autosave', async () => {
    const cv = makeCv();
    const cvsRepo = {
      findOne: jest.fn().mockResolvedValue(cv),
      save: jest.fn(),
      // emulate the DB applying the column patch, like the real UPDATE would
      update: jest.fn().mockImplementation((_id, patch) => {
        Object.assign(cv, patch);
        return Promise.resolve({ affected: 1 });
      }),
    };
    const service = setup(cvsRepo);

    const dto = {
      parsedJson: { language: 'en', skills: {}, summary: 'edited' },
      title: 'CV Builder draft', // what a stale pre-W97 bundle sends on every keystroke-save
    } as unknown as UpdateBuilderCvDto;
    const res = await service.updateBuilderDraft('user-1', 'cv-1', dto);

    // Column-scoped UPDATE without title — immune to the read-modify-write lost update where
    // a rename landing mid-autosave got reverted by a full-entity save.
    expect(cvsRepo.update).toHaveBeenCalledWith(
      'cv-1',
      expect.objectContaining({ parsedJson: { language: 'en', skills: {}, summary: 'edited' } }),
    );
    expect(cvsRepo.update.mock.calls[0][1]).not.toHaveProperty('title');
    expect(cvsRepo.save).not.toHaveBeenCalled();
    expect(res.title).toBe('Renamed by user');
    expect(res.parsedJson).toEqual({ language: 'en', skills: {}, summary: 'edited' });
  });
});

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CvsService } from './cvs.service';

/**
 * Title-only rename: works for any owned CV (not just BUILT), trims, never touches the
 * document, and 404s when the CV is not owned. Guards the P2 rename endpoint that replaces
 * the old GET+full-PUT workaround (which threw for uploaded CVs). Writes are column-scoped
 * (UPDATE title only) so a rename can never revert a concurrent autosave's parsedJson.
 */
describe('CvsService.rename', () => {
  function makeCv(overrides: Record<string, unknown> = {}) {
    return {
      id: 'cv-1',
      userId: 'user-1',
      title: 'Old title',
      originalFileName: null,
      fileType: null,
      fileSize: null,
      parsedText: null,
      parsedJson: null,
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

  function setup(cvsRepo: Record<string, jest.Mock>) {
    return new CvsService(
      cvsRepo as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );
  }

  function makeRepo(cv: Record<string, unknown>) {
    return {
      findOne: jest.fn().mockResolvedValue(cv),
      save: jest.fn(),
      // emulate the DB applying the column patch, like the real UPDATE would
      update: jest.fn().mockImplementation((_id, patch) => {
        Object.assign(cv, patch);
        return Promise.resolve({ affected: 1 });
      }),
    };
  }

  it('trims and sets the title via a title-only UPDATE, returns the slim response', async () => {
    const cv = makeCv({ title: 'Old title' });
    const cvsRepo = makeRepo(cv);
    const service = setup(cvsRepo);

    const res = await service.rename('user-1', 'cv-1', '  New title  ');

    // slim contract response — no canonical doc, no skills payload for a title change
    expect(res).toEqual({ id: 'cv-1', title: 'New title', updatedAt: expect.any(String) });
    // column-scoped write: EXACTLY the title, so a rename can never write back a stale
    // parsedJson over a concurrent autosave (full-entity save did)
    expect(cvsRepo.update).toHaveBeenCalledWith('cv-1', { title: 'New title' });
    expect(cvsRepo.save).not.toHaveBeenCalled();
    expect(cvsRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'cv-1', userId: 'user-1' }) }),
    );
  });

  it('renames an UPLOADED CV too (no BUILT gate, no doc touch)', async () => {
    const cv = makeCv({ cvKind: 'UPLOADED', title: 'Resume.pdf', parsedText: 'original text' });
    const cvsRepo = makeRepo(cv);
    const service = setup(cvsRepo);

    const res = await service.rename('user-1', 'cv-1', 'My Best Resume');

    expect(res.title).toBe('My Best Resume');
    // untouched document on the entity itself
    expect(cv.parsedText).toBe('original text');
    expect(cv.cvKind).toBe('UPLOADED');
  });

  it('keeps a valid custom title when refreshing duplicate upload metadata', async () => {
    const cv = makeCv({
      title: 'Åge CV',
      originalFileName: 'old-resume.pdf',
      cvKind: 'UPLOADED',
    });
    const cvsRepo = makeRepo(cv);
    const service = setup(cvsRepo);

    await (
      service as unknown as {
        refreshDuplicateUploadMetadata: (
          duplicate: typeof cv,
          originalFileName: string,
          requestedTitle: string,
        ) => Promise<void>;
      }
    ).refreshDuplicateUploadMetadata(cv, 'new-resume.pdf', 'new-resume.pdf');

    expect(cv.title).toBe('Åge CV');
    expect(cvsRepo.update).toHaveBeenCalledWith('cv-1', {
      originalFileName: 'new-resume.pdf',
    });
  });

  it('rejects an empty-after-trim title with TITLE_REQUIRED before touching the DB', async () => {
    const cvsRepo = makeRepo(makeCv());
    const service = setup(cvsRepo);

    const err = await service.rename('user-1', 'cv-1', '   ').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({
      errorCode: 'TITLE_REQUIRED',
    });
    expect(cvsRepo.findOne).not.toHaveBeenCalled();
    expect(cvsRepo.update).not.toHaveBeenCalled();
  });

  it('throws NotFound and never writes when the CV is not owned', async () => {
    const cvsRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn(),
      update: jest.fn(),
    };
    const service = setup(cvsRepo);

    await expect(service.rename('user-1', 'missing', 'X')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(cvsRepo.update).not.toHaveBeenCalled();
  });
});

import { NotFoundException } from '@nestjs/common';
import { CvsService } from './cvs.service';

/**
 * Title-only rename: works for any owned CV (not just BUILT), trims, never touches the
 * document, and 404s when the CV is not owned. Guards the P2 rename endpoint that replaces
 * the old GET+full-PUT workaround (which threw for uploaded CVs).
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

  it('trims and sets the title, bumps via save, returns the new title', async () => {
    const cv = makeCv({ title: 'Old title' });
    const cvsRepo = {
      findOne: jest.fn().mockResolvedValue(cv),
      save: jest.fn().mockImplementation((c) => Promise.resolve(c)),
    };
    const service = setup(cvsRepo);

    const res = await service.rename('user-1', 'cv-1', '  New title  ');

    expect(res.title).toBe('New title');
    expect(cvsRepo.save).toHaveBeenCalledTimes(1);
    expect(cvsRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'cv-1', userId: 'user-1' }) }),
    );
  });

  it('renames an UPLOADED CV too (no BUILT gate, no doc touch)', async () => {
    const cv = makeCv({ cvKind: 'UPLOADED', title: 'Resume.pdf', parsedText: 'original text' });
    const cvsRepo = {
      findOne: jest.fn().mockResolvedValue(cv),
      save: jest.fn().mockImplementation((c) => Promise.resolve(c)),
    };
    const service = setup(cvsRepo);

    const res = await service.rename('user-1', 'cv-1', 'My Best Resume');

    expect(res.title).toBe('My Best Resume');
    expect(res.cvKind).toBe('UPLOADED');
    // untouched document
    expect(res.parsedText).toBe('original text');
  });

  it('throws NotFound and never saves when the CV is not owned', async () => {
    const cvsRepo = { findOne: jest.fn().mockResolvedValue(null), save: jest.fn() };
    const service = setup(cvsRepo);

    await expect(service.rename('user-1', 'missing', 'X')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(cvsRepo.save).not.toHaveBeenCalled();
  });
});

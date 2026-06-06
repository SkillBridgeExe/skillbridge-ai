import { CvsRetentionService } from '../../../src/platform/cvs/cv-retention.service';

describe('CvsRetentionService', () => {
  const now = new Date('2026-06-06T00:00:00.000Z');

  function build() {
    const cvsRepo = {
      find: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    const cvSkillsRepo = {
      delete: jest.fn().mockResolvedValue(undefined),
    };
    const consentAuditsRepo = {
      delete: jest.fn().mockResolvedValue(undefined),
    };
    const storage = {
      delete: jest.fn().mockResolvedValue(undefined),
    };
    const service = new CvsRetentionService(
      cvsRepo as never,
      cvSkillsRepo as never,
      consentAuditsRepo as never,
      storage as never,
    );
    return { service, cvsRepo, cvSkillsRepo, consentAuditsRepo, storage };
  }

  it('deletes old active non-OCR uploaded files and keeps the CV row data', async () => {
    const { service, cvsRepo, storage } = build();
    cvsRepo.find.mockResolvedValue([
      { id: 'cv-1', fileUrl: 'cvs/u1/cv-1/file.pdf', isOcrOnly: false },
    ]);

    const result = await service.cleanupExpiredOriginalFiles(now);

    expect(storage.delete).toHaveBeenCalledWith('cvs/u1/cv-1/file.pdf');
    expect(cvsRepo.update).toHaveBeenCalledWith({ id: 'cv-1' }, { fileUrl: null });
    expect(result).toEqual({ filesDeleted: 1, rowsUpdated: 1 });
  });

  it('purges soft-deleted CV rows older than 30 days and clears child rows without FKs', async () => {
    const { service, cvsRepo, cvSkillsRepo, consentAuditsRepo } = build();
    cvsRepo.find.mockResolvedValue([{ id: 'cv-old' }]);

    const result = await service.purgeSoftDeletedRows(now);

    expect(cvSkillsRepo.delete).toHaveBeenCalledWith({ cvId: 'cv-old' });
    expect(consentAuditsRepo.delete).toHaveBeenCalledWith({ cvId: 'cv-old' });
    expect(cvsRepo.delete).toHaveBeenCalledWith({ id: 'cv-old' });
    expect(result).toEqual({ rowsPurged: 1 });
  });
});

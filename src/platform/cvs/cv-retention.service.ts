import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThanOrEqual, Not, Repository } from 'typeorm';
import { CvConsentAuditEntity } from '../../database/entities/cv-consent-audit.entity';
import { CvEntity } from '../../database/entities/cv.entity';
import { CvSkillEntity } from '../../database/entities/cv-skill.entity';
import { GcsStorageService } from '../../infrastructure/storage/gcs-storage.service';

const RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class CvsRetentionService {
  constructor(
    @InjectRepository(CvEntity) private readonly cvs: Repository<CvEntity>,
    @InjectRepository(CvSkillEntity) private readonly cvSkills: Repository<CvSkillEntity>,
    @InjectRepository(CvConsentAuditEntity)
    private readonly consentAudits: Repository<CvConsentAuditEntity>,
    private readonly storage: GcsStorageService,
  ) {}

  async cleanupExpiredOriginalFiles(
    now = new Date(),
  ): Promise<{ filesDeleted: number; rowsUpdated: number }> {
    const cutoff = this.cutoff(now);
    const rows = await this.cvs.find({
      where: {
        cvKind: 'UPLOADED',
        fileUrl: Not(IsNull()),
        isOcrOnly: false,
        deletedAt: IsNull(),
        createdAt: LessThanOrEqual(cutoff),
      },
    });

    let filesDeleted = 0;
    let rowsUpdated = 0;
    for (const cv of rows) {
      if (!cv.fileUrl) continue;
      await this.storage.delete(cv.fileUrl);
      filesDeleted += 1;
      await this.cvs.update({ id: cv.id }, { fileUrl: null });
      rowsUpdated += 1;
    }
    return { filesDeleted, rowsUpdated };
  }

  async purgeSoftDeletedRows(now = new Date()): Promise<{ rowsPurged: number }> {
    const cutoff = this.cutoff(now);
    const rows = await this.cvs.find({
      where: { deletedAt: LessThanOrEqual(cutoff) },
      withDeleted: true,
    });

    let rowsPurged = 0;
    for (const cv of rows) {
      if (cv.fileUrl) await this.storage.delete(cv.fileUrl);
      await this.cvSkills.delete({ cvId: cv.id });
      await this.consentAudits.delete({ cvId: cv.id });
      await this.cvs.delete({ id: cv.id });
      rowsPurged += 1;
    }
    return { rowsPurged };
  }

  private cutoff(now: Date): Date {
    return new Date(now.getTime() - RETENTION_DAYS * DAY_MS);
  }
}

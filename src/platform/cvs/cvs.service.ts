import {
  BadRequestException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { AiResultEntity } from '../../database/entities/ai-result.entity';
import { CvConsentAuditEntity } from '../../database/entities/cv-consent-audit.entity';
import { CvEntity } from '../../database/entities/cv.entity';
import { CvSkillEntity } from '../../database/entities/cv-skill.entity';
import { SkillEntity } from '../../database/entities/skill.entity';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { SkillNormalizerService } from '../../common/services/skill-normalizer.service';
import {
  DownloadedFile,
  GcsStorageService,
} from '../../infrastructure/storage/gcs-storage.service';
import { CvReviewService } from '../../modules/cv-review/cv-review.service';
import { CvReviewParsedResponse } from '../../modules/cv-review/dto/cv-review-response.dto';
import { CreateCvDto } from './dto/create-cv.dto';
import { CvListItemDto, CvResponseDto, CvSkillResponseDto } from './dto/cv-response.dto';
import { TextExtractorService } from './text-extractor.service';

const MAX_CV_FILE_BYTES = 5 * 1024 * 1024;
const CV_PROCESSING_CONSENT_VERSION = 'cv-processing-v1';
const CV_UPLOAD_CONSENT_SOURCE = 'cv_upload';
const SUPPORTED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
]);

@Injectable()
export class CvsService {
  constructor(
    @InjectRepository(CvEntity) private readonly cvs: Repository<CvEntity>,
    @InjectRepository(CvSkillEntity) private readonly cvSkills: Repository<CvSkillEntity>,
    @InjectRepository(SkillEntity) private readonly skills: Repository<SkillEntity>,
    private readonly storage: GcsStorageService,
    private readonly extractor: TextExtractorService,
    private readonly cvReview: CvReviewService,
    private readonly skillNormalizer: SkillNormalizerService,
    @InjectRepository(CvConsentAuditEntity)
    private readonly consentAudits: Repository<CvConsentAuditEntity>,
    @InjectRepository(AiResultEntity)
    private readonly aiResults: Repository<AiResultEntity>,
  ) {}

  async create(
    userId: string,
    dto: CreateCvDto,
    file: Express.Multer.File,
  ): Promise<CvResponseDto> {
    this.validateFile(file);
    if (dto.consentAccepted !== true) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.VALIDATION_ERROR,
        message: 'CV processing consent is required',
      });
    }

    const cvId = uuidv4();
    const objectKey = this.storage.buildCvObjectKey(userId, cvId, file.originalname);
    const targetRole = this.normalizeTargetRole(dto.targetRole);
    let cvSaved = false;

    await this.storage.upload({
      key: objectKey,
      body: file.buffer,
      contentType: file.mimetype,
    });

    try {
      const extracted = await this.extractor.extract(file);
      let cv = await this.cvs.save(
        this.cvs.create({
          id: cvId,
          userId,
          title: dto.title?.trim() || file.originalname,
          originalFileName: file.originalname,
          fileType: file.mimetype,
          fileSize: file.size,
          fileUrl: objectKey,
          parsedText: extracted.text,
          cvKind: 'UPLOADED',
          targetRole,
          isOcrOnly: extracted.isOcrOnly,
        }),
      );
      cvSaved = true;
      await this.recordConsentAudit(userId, cv.id);

      const review = await this.reviewCv(userId, cv, targetRole ?? undefined);
      cv = review.cv;

      return this.toResponse(cv, review.skills, review.parsed);
    } catch (error) {
      if (!cvSaved) await this.storage.delete(objectKey).catch(() => undefined);
      throw error;
    }
  }

  async list(
    userId: string,
    options: { page: number; limit: number },
  ): Promise<{ items: CvListItemDto[]; total: number; page: number; limit: number }> {
    const [items, total] = await this.cvs.findAndCount({
      where: { userId },
      order: { createdAt: 'DESC' },
      skip: (options.page - 1) * options.limit,
      take: options.limit,
    });

    return {
      items: items.map((cv) => this.toListItem(cv)),
      total,
      page: options.page,
      limit: options.limit,
    };
  }

  async get(userId: string, cvId: string): Promise<CvResponseDto> {
    const cv = await this.findOwnedCv(userId, cvId);
    const [skills, review] = await Promise.all([
      this.getPersistedSkills(cv.id),
      this.getLatestPersistedReview(userId, cv.id),
    ]);
    return this.toResponse(cv, skills, review);
  }

  async download(userId: string, cvId: string): Promise<{ cv: CvEntity; file: DownloadedFile }> {
    const cv = await this.findOwnedCv(userId, cvId);
    if (!cv.fileUrl) throw new NotFoundException('CV file not found');
    return { cv, file: await this.storage.download(cv.fileUrl) };
  }

  async remove(userId: string, cvId: string): Promise<void> {
    const cv = await this.findOwnedCv(userId, cvId);
    if (cv.fileUrl) await this.storage.delete(cv.fileUrl).catch(() => undefined);
    await this.cvs.softDelete({ id: cvId, userId });
  }

  async rerunReview(userId: string, cvId: string): Promise<CvResponseDto> {
    const cv = await this.findOwnedCv(userId, cvId);
    if (!cv.parsedText) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.CV_PARSE_FAILED,
        message: 'CV has no parsed text to review',
      });
    }

    const review = await this.reviewCv(userId, cv);
    return this.toResponse(review.cv, review.skills, review.parsed);
  }

  private async reviewCv(
    userId: string,
    cv: CvEntity,
    targetRole?: string,
  ): Promise<{ cv: CvEntity; parsed: CvReviewParsedResponse; skills: CvSkillResponseDto[] }> {
    if (!cv.parsedText) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.CV_PARSE_FAILED,
        message: 'CV parsed text is missing',
      });
    }

    const effectiveTargetRole = this.normalizeTargetRole(targetRole ?? cv.targetRole ?? undefined);

    const review = await this.cvReview.review(userId, {
      cv_id: cv.id,
      parsed_text: cv.parsedText,
      prompt_template_code: 'cv_review_v1',
      target_role: effectiveTargetRole ?? undefined,
      mime_type: cv.fileType ?? undefined,
      is_ocr_only: cv.isOcrOnly,
    });
    const parsed = review.parsed_response;

    cv.parsedJson = parsed.document;
    cv.language = parsed.language;
    cv.atsReadabilityScore = parsed.ats_rule_score.toFixed(2);
    cv.targetRole = effectiveTargetRole;
    const saved = await this.cvs.save(cv);
    const skills = await this.persistExtractedSkills(
      saved.id,
      parsed.ats_extracted.skills_raw ?? [],
    );

    return { cv: saved, parsed, skills };
  }

  private async persistExtractedSkills(
    cvId: string,
    rawSkills: string[],
  ): Promise<CvSkillResponseDto[]> {
    const uniqueRawSkills = [...new Set(rawSkills.map((s) => s.trim()).filter(Boolean))];
    // Async variant = deterministic cascade + embedding fallback for the long tail
    // (semantic tier fires only on full cascade misses; no-ops in test/keyless envs).
    const normalized = await this.skillNormalizer.normalizeManyAsync(uniqueRawSkills);
    const canonicalNames = [
      ...new Set(
        normalized
          .map((skill) => skill.canonical_name)
          .filter((value): value is string => typeof value === 'string' && value.length > 0),
      ),
    ];

    const entities =
      canonicalNames.length > 0
        ? await this.skills.find({ where: { canonicalName: In(canonicalNames) } })
        : [];
    const entityByCanonical = new Map(entities.map((skill) => [skill.canonicalName, skill]));

    await this.cvSkills.delete({ cvId });
    const rowsBySkillId = new Map<string, CvSkillEntity>();
    for (const skill of normalized) {
      if (!skill.canonical_name) continue;
      const entity = entityByCanonical.get(skill.canonical_name);
      if (!entity) continue;
      const row = this.cvSkills.create({
        cvId,
        skillId: entity.id,
        confidence: skill.confidence.toFixed(2),
      });
      const existing = rowsBySkillId.get(entity.id);
      if (!existing || Number(row.confidence ?? 0) > Number(existing.confidence ?? 0)) {
        rowsBySkillId.set(entity.id, row);
      }
    }
    const rows = [...rowsBySkillId.values()];
    if (rows.length > 0) await this.cvSkills.save(rows);

    return normalized.map((skill) => {
      const entity = skill.canonical_name ? entityByCanonical.get(skill.canonical_name) : undefined;
      return {
        id: entity?.id ?? null,
        canonicalName: skill.canonical_name,
        displayName: skill.display_name,
        rawInput: skill.raw_input,
        matchedVia: skill.matched_via,
        confidence: skill.confidence,
      };
    });
  }

  private async getPersistedSkills(cvId: string): Promise<CvSkillResponseDto[]> {
    const links = await this.cvSkills.find({ where: { cvId } });
    if (links.length === 0) return [];
    const skillIds = links.map((link) => link.skillId);
    const skills = await this.skills.find({ where: { id: In(skillIds) } });
    const skillById = new Map(skills.map((skill) => [skill.id, skill]));

    return links.map((link) => {
      const skill = skillById.get(link.skillId);
      return {
        id: skill?.id ?? link.skillId,
        canonicalName: skill?.canonicalName ?? null,
        displayName: skill?.displayName ?? null,
        rawInput: skill?.displayName ?? link.skillId,
        matchedVia: 'persisted',
        confidence: link.confidence ? Number(link.confidence) : 0,
      };
    });
  }

  private async getLatestPersistedReview(
    userId: string,
    cvId: string,
  ): Promise<CvReviewParsedResponse | null> {
    const rows = (await this.aiResults.manager.query(
      `
        SELECT ar.parsed_response
        FROM ai_results ar
        INNER JOIN ai_requests req ON req.id = ar.ai_request_id
        WHERE ar.user_id = $1
          AND ar.result_type = 'cv_review'
          AND req.request_payload -> 'payload' ->> 'cv_id' = $2
        ORDER BY ar.created_at DESC
        LIMIT 1
      `,
      [userId, cvId],
    )) as Array<{ parsed_response: CvReviewParsedResponse | null }>;

    return rows[0]?.parsed_response ?? null;
  }

  private async recordConsentAudit(userId: string, cvId: string): Promise<void> {
    await this.consentAudits.save(
      this.consentAudits.create({
        userId,
        cvId,
        consentVersion: CV_PROCESSING_CONSENT_VERSION,
        consentSource: CV_UPLOAD_CONSENT_SOURCE,
        acceptedAt: new Date(),
      }),
    );
  }

  private normalizeTargetRole(value: string | null | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  }

  private validateFile(file: Express.Multer.File | undefined): asserts file is Express.Multer.File {
    if (!file) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.VALIDATION_ERROR,
        message: 'CV file is required',
      });
    }
    if (file.size > MAX_CV_FILE_BYTES) {
      throw new PayloadTooLargeException({
        errorCode: ERROR_CODES.FILE_TOO_LARGE,
        message: 'CV file must be 5MB or smaller',
      });
    }
    if (!SUPPORTED_MIME_TYPES.has(file.mimetype)) {
      throw new UnsupportedMediaTypeException({
        errorCode: ERROR_CODES.UNSUPPORTED_FILE_TYPE,
        message: 'Only PDF, DOCX, PNG, JPG, and WEBP CV files are supported',
      });
    }
  }

  private async findOwnedCv(userId: string, cvId: string): Promise<CvEntity> {
    const cv = await this.cvs.findOne({ where: { id: cvId, userId } });
    if (!cv) throw new NotFoundException('CV not found');
    return cv;
  }

  private toResponse(
    cv: CvEntity,
    skills: CvSkillResponseDto[],
    review: CvReviewParsedResponse | null,
  ): CvResponseDto {
    return {
      id: cv.id,
      title: cv.title,
      originalFileName: cv.originalFileName,
      fileType: cv.fileType,
      fileSize: cv.fileSize,
      downloadUrl: `/api/cvs/${cv.id}/file`,
      parsedText: cv.parsedText,
      parsedJson: cv.parsedJson,
      cvKind: cv.cvKind,
      language: cv.language,
      targetRole: cv.targetRole,
      isOcrOnly: cv.isOcrOnly,
      atsReadabilityScore: cv.atsReadabilityScore ? Number(cv.atsReadabilityScore) : null,
      skills,
      review,
      createdAt: cv.createdAt.toISOString(),
      updatedAt: cv.updatedAt ? cv.updatedAt.toISOString() : null,
    };
  }

  private toListItem(cv: CvEntity): CvListItemDto {
    return {
      id: cv.id,
      title: cv.title,
      originalFileName: cv.originalFileName,
      fileType: cv.fileType,
      fileSize: cv.fileSize,
      language: cv.language,
      targetRole: cv.targetRole,
      isOcrOnly: cv.isOcrOnly,
      atsReadabilityScore: cv.atsReadabilityScore ? Number(cv.atsReadabilityScore) : null,
      createdAt: cv.createdAt.toISOString(),
    };
  }
}

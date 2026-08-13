import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { isDeepStrictEqual } from 'util';
import { EntityManager, In, IsNull, Not, Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { BillingFeatureKey, BillingPlanCode } from '../../common/constants/billing.constants';
import { CanonicalCvDocument, emptyCanonicalCv } from '../../common/types/canonical-cv';
import { AiResultEntity } from '../../database/entities/ai-result.entity';
import { CvConsentAuditEntity } from '../../database/entities/cv-consent-audit.entity';
import { CvEntity, CvKind } from '../../database/entities/cv.entity';
import { CvSkillEntity } from '../../database/entities/cv-skill.entity';
import { CvVersionEntity, CvVersionOrigin } from '../../database/entities/cv-version.entity';
import { SkillEntity } from '../../database/entities/skill.entity';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { documentToPlainText } from '../../common/services/cv-document-text';
import { RoleRubricService } from '../../common/services/role-rubric.service';
import { SkillNormalizerService } from '../../common/services/skill-normalizer.service';
import { EntitlementsService } from '../billing/entitlements.service';
import { CreditAwareReservation } from '../billing/credit-aware-usage.service';
import {
  CvAssistantRewriteService,
  CvAssistantRewriteResult,
} from '../../modules/cv-assistant/cv-assistant.service';
import { groundCvAssistantAnswers } from '../../modules/cv-assistant/cv-assistant-rewrite';
import { cvBuilderAssistantTurn1, CvAssistantTurn } from '../../modules/cv-assistant/cv-assistant';
import {
  AssistantExplanation,
  buildCvAssistantExplanation,
} from '../../modules/cv-assistant/cv-assistant-explain';
import {
  analyzeSkillsSection,
  SkillsNudge,
  SkillsSection,
} from '../../modules/cv-assistant/cv-assistant-skills';
import { CvQuestionGeneratorService } from '../../modules/cv-assistant/cv-question-generator.service';
import {
  AssistantAnalyzeRequestDto,
  AssistantExplainRequestDto,
  AssistantRewriteRequestDto,
  AssistantSmartQuestionsRequestDto,
  ExtractRequestDto,
} from './dto/cv-assistant.dto';
import { CvVersionDetailDto, CvVersionSummaryDto } from './dto/cv-version.dto';
import { CvIntakeResult, CvIntakeService } from '../../modules/cv-intake/cv-intake.service';
import {
  DownloadedFile,
  GcsStorageService,
} from '../../infrastructure/storage/gcs-storage.service';
import { SectionEvaluatorService } from '../../modules/cv-builder/section-evaluator.service';
import { CvRewriteService } from '../../modules/cv-builder/cv-rewrite.service';
import { RoleInferenceService } from '../../modules/cv-builder/role-inference.service';
import { mergeStoryItems } from '../../modules/cv-builder/story-merge';
import { StoryExtractionService } from '../../modules/cv-builder/story-extraction.service';
import {
  CareerTargetStoryRequestDto,
  CareerTargetStoryResponseDto,
} from './dto/career-target-story.dto';
import { StoryReadinessRequestDto, StoryReadinessResponseDto } from './dto/story-readiness.dto';
import { SkillDiffService } from '../../modules/cv-jd-match/skill-diff.service';
import { CvJdMatchParsedResponse } from '../../modules/cv-jd-match/dto/cv-jd-match-response.dto';
import { buildGapItems } from '../../modules/gap-engine/gap-item';
import { computeReadiness, cvSkillsFromDoc } from '../../modules/cv-builder/readiness';
import { StoryApplyRequestDto, StoryApplyResponseDto } from './dto/story-apply.dto';
import { StoryExtractRequestDto, StoryExtractResponseDto } from './dto/story-extract.dto';
import { ProjectIntakeRequestDto, ProjectIntakeResponseDto } from './dto/project-intake.dto';
import { VerifiedTailorAction } from '../../modules/cv-builder/tailor-verification';
import { TailorVerifierService } from '../tailor-verifier/tailor-verifier.service';
import {
  EvaluateSectionRequestDto,
  EvaluateSectionResponseDto,
} from '../../modules/cv-builder/dto/evaluate-section.dto';
import { RewriteRequestDto, RewriteResponseDto } from '../../modules/cv-builder/dto/rewrite.dto';
import { CvReviewService } from '../../modules/cv-review/cv-review.service';
import { CvReviewParsedResponse } from '../../modules/cv-review/dto/cv-review-response.dto';
import {
  GithubEvidenceDto,
  GithubEvidenceService,
} from '../../modules/github-evidence/github-evidence.service';
import { InterviewPlanResponseDto } from '../../modules/interview/dto/interview-plan.dto';
import { InterviewPlanService } from '../../modules/interview/interview-plan.service';
import { CreateBuilderCvDto, UpdateBuilderCvDto } from './dto/builder-cv.dto';
import { CreateCvDto } from './dto/create-cv.dto';
import { RenameCvResponseDto } from './dto/rename-cv.dto';
import { CvListItemDto, CvResponseDto, CvSkillResponseDto } from './dto/cv-response.dto';
import { CvPdfRendererService, RenderedCvPdf } from './cv-pdf-renderer.service';
import { TextExtractorService } from './text-extractor.service';
import { CvAnalysisQuotaService } from './cv-analysis-quota.service';
import { diagnosisPremiumView } from './diagnosis-premium-access';

const MAX_CV_FILE_BYTES = 5 * 1024 * 1024;
const CV_PROCESSING_CONSENT_VERSION = 'cv-processing-v1';
const CV_UPLOAD_CONSENT_SOURCE = 'cv_upload';
const CV_REVIEW_PROMPT_CODE = 'cv_review_v1';
const MOJIBAKE_MARKER =
  /[\u0080-\u009f]|\uFFFD|Ã|Â|Ä|Å|Æ|á(?:º|»)|â(?:[\u0080-\u00bf]|[\u2010-\u2027]|\u20ac)/gu;
const WINDOWS_1252_BYTE = new Map<number, number>([
  [0x20ac, 0x80],
  [0x201a, 0x82],
  [0x0192, 0x83],
  [0x201e, 0x84],
  [0x2026, 0x85],
  [0x2020, 0x86],
  [0x2021, 0x87],
  [0x02c6, 0x88],
  [0x2030, 0x89],
  [0x0160, 0x8a],
  [0x2039, 0x8b],
  [0x0152, 0x8c],
  [0x017d, 0x8e],
  [0x2018, 0x91],
  [0x2019, 0x92],
  [0x201c, 0x93],
  [0x201d, 0x94],
  [0x2022, 0x95],
  [0x2013, 0x96],
  [0x2014, 0x97],
  [0x02dc, 0x98],
  [0x2122, 0x99],
  [0x0161, 0x9a],
  [0x203a, 0x9b],
  [0x0153, 0x9c],
  [0x017e, 0x9e],
  [0x0178, 0x9f],
]);
const SUPPORTED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
]);

function mojibakeScore(value: string): number {
  return value.match(MOJIBAKE_MARKER)?.length ?? 0;
}

function legacyHeaderBytes(value: string): Buffer | null {
  const bytes: number[] = [];
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0xff) {
      bytes.push(codePoint);
      continue;
    }
    const windows1252Byte = WINDOWS_1252_BYTE.get(codePoint);
    if (windows1252Byte === undefined) return null;
    bytes.push(windows1252Byte);
  }
  return Buffer.from(bytes);
}

function normalizeCvMetadataText(value: string): string {
  const normalized = value.trim().normalize('NFC');
  const originalScore = mojibakeScore(normalized);
  if (!originalScore) return normalized;
  const legacyBytes = legacyHeaderBytes(normalized);
  if (!legacyBytes) return normalized;
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(legacyBytes).normalize('NFC');
    return !decoded.includes('\uFFFD') && mojibakeScore(decoded) < originalScore
      ? decoded
      : normalized;
  } catch {
    return normalized;
  }
}

export type CvReviewState = 'CACHED' | 'CREATED' | 'NONE';

export interface PreparedCvAnalysis {
  cv: CvResponseDto;
  reviewState: CvReviewState;
  reservation: CreditAwareReservation | null;
}

@Injectable()
export class CvsService {
  private readonly logger = new Logger(CvsService.name);

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
    private readonly evaluator: SectionEvaluatorService,
    private readonly rewriter: CvRewriteService,
    private readonly roleInference: RoleInferenceService,
    private readonly storyExtraction: StoryExtractionService,
    private readonly pdfRenderer: CvPdfRendererService,
    private readonly analysisQuota: CvAnalysisQuotaService,
    private readonly entitlements: EntitlementsService,
    // Story→CV slice 4 — rubric-only gap + readiness (reuses the existing eval-gated matching
    // engine; no new scoring logic). Provided at runtime via CvJdMatchModule import on CvsModule.
    private readonly skillDiff: SkillDiffService,
    private readonly interviewPlan?: InterviewPlanService,
    private readonly githubEvidence?: GithubEvidenceService,
    // PR4.5 — verifies a tailor action server-side (reloads match + gap report). The `?` is forced
    // by TS (it follows the two optionals above) and lets unit tests omit it; it is NOT @Optional()
    // for Nest, so CvsModule's TailorVerifierModule import makes it ALWAYS present at runtime (the
    // app fails to boot loudly if that import is dropped). Do NOT add @Optional() — the guard below
    // would then be the only thing standing between a mis-wired prod and an unverified tailor.
    private readonly tailorVerifier?: TailorVerifierService,
    // Companion V1a — CV Builder assistant Turn-2 rewrite engine. Provided at runtime via CvsModule;
    // the `?` only satisfies TS (it follows the optionals above) and lets unit tests omit it.
    private readonly cvAssistant?: CvAssistantRewriteService,
    // Narrative intake (Phase 1: experience) — free-text story → structured fields. Provided at
    // runtime via CvsModule; the `?` only satisfies TS (it trails the optionals) and lets unit
    // tests omit it.
    private readonly cvIntake?: CvIntakeService,
    // Companion Turn-1.5 — role-aware smart-question generator (LLM, opt-in). Provided at runtime
    // via CvsModule; the `?` only satisfies TS (it trails the optionals above) and lets unit tests
    // omit it — it is NOT @Optional() for Nest, so a dropped provider fails boot loudly.
    private readonly questionGenerator?: CvQuestionGeneratorService,
    // P2 builder management — version-snapshot repo. @InjectRepository provides the token, so it is
    // ALWAYS present at runtime (CvsModule registers CvVersionEntity); the `?` only trails the
    // optionals above so existing unit tests that omit it still compile. Access via `this.versions`.
    @InjectRepository(CvVersionEntity)
    private readonly cvVersions?: Repository<CvVersionEntity>,
    // Role rubrics are the authoritative public diagnosis-role contract. The `?` only preserves
    // direct unit-test construction; Nest still resolves this parameter and fails boot if the
    // globally exported provider is missing (there is deliberately no @Optional decorator).
    private readonly roleRubrics?: RoleRubricService,
  ) {}

  async create(
    userId: string,
    dto: CreateCvDto,
    file: Express.Multer.File,
  ): Promise<CvResponseDto> {
    const result = await this.createForAnalysis(userId, dto, file);
    await result.reservation?.confirm({ sourceType: 'cv', sourceId: result.cv.id });
    return result.cv;
  }

  async createForAnalysis(
    userId: string,
    dto: CreateCvDto,
    file: Express.Multer.File,
  ): Promise<PreparedCvAnalysis> {
    const normalizedOriginalFileName = normalizeCvMetadataText(file.originalname);
    const normalizedFile =
      normalizedOriginalFileName === file.originalname
        ? file
        : { ...file, originalname: normalizedOriginalFileName };
    const requestedTitle = dto.title?.trim()
      ? normalizeCvMetadataText(dto.title)
      : normalizedOriginalFileName;
    this.validateFile(normalizedFile);
    if (dto.consentAccepted !== true) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.VALIDATION_ERROR,
        message: 'CV processing consent is required',
      });
    }

    // Reject an unsupported explicit role before fingerprint lookup, cache reuse, quota, storage,
    // or any CV mutation. A deep guard in CvReviewService is too late for these orchestration paths.
    const requestedRole = this.normalizeTargetRole(dto.targetRole);
    this.assertSupportedTargetRole(requestedRole);

    const generatedSource = await this.findGeneratedPdfSource(userId, normalizedFile);
    if (generatedSource) {
      const role = requestedRole ?? generatedSource.targetRole ?? null;
      this.assertSupportedTargetRole(role);
      const cached = await this.getLatestMatchingReview(userId, generatedSource.id, role, dto.lang);
      if (cached) {
        return {
          cv: await this.toResponse(
            generatedSource,
            await this.getPersistedSkills(generatedSource.id),
            cached,
          ),
          reviewState: 'CACHED',
          reservation: null,
        };
      }

      const parsedText = this.reviewableText(generatedSource);
      if (!parsedText) {
        throw new BadRequestException({
          errorCode: ERROR_CODES.CV_PARSE_FAILED,
          message: 'CV has no parsed text to review',
        });
      }

      generatedSource.parsedText = parsedText;
      if (role && role !== generatedSource.targetRole) {
        generatedSource.targetRole = role;
        // Column-scoped — a full save would write back this whole pre-read row (lost update).
        await this.cvs.update(generatedSource.id, { targetRole: role });
      }
      const usage = await this.analysisQuota.reserveAnalysis(userId);
      try {
        const review = await this.reviewCv(userId, generatedSource, role ?? undefined, dto.lang);
        return {
          cv: await this.toResponse(review.cv, review.skills, review.parsed),
          reviewState: 'CREATED',
          reservation: usage,
        };
      } catch (error) {
        await usage?.refund();
        throw error;
      }
    }

    const contentHash = this.sha256(normalizedFile.buffer);
    const duplicate = await this.findDuplicateContentHash(userId, contentHash);
    if (duplicate) {
      await this.refreshDuplicateUploadMetadata(
        duplicate,
        normalizedOriginalFileName,
        requestedTitle,
      );
      // Role-aware dedup: the review is scored against the TARGET ROLE's rubric
      // (skills_relevance + skill breakdown), so reuse a prior analysis ONLY when one
      // exists for the requested role. Re-uploading the same file under a NEW role must
      // re-grade — otherwise the user sees the previous role's analysis on a fast-but-wrong
      // scan. A request without a role (null) matches the latest analysis of any role.
      const cachedForRole = await this.getLatestMatchingReview(
        userId,
        duplicate.id,
        requestedRole ?? null,
        dto.lang,
      );
      if (cachedForRole) {
        return {
          cv: await this.toResponse(
            duplicate,
            await this.getPersistedSkills(duplicate.id),
            cachedForRole,
          ),
          reviewState: 'CACHED',
          reservation: null,
        };
      }
      const usage = await this.analysisQuota.reserveAnalysis(userId);
      try {
        if (requestedRole && requestedRole !== duplicate.targetRole) {
          duplicate.targetRole = requestedRole;
          // Column-scoped — a full save would write back this whole pre-read row (lost update).
          await this.cvs.update(duplicate.id, { targetRole: requestedRole });
        }
        const review = await this.reviewCv(userId, duplicate, requestedRole ?? undefined, dto.lang);
        return {
          cv: await this.toResponse(review.cv, review.skills, review.parsed),
          reviewState: 'CREATED',
          reservation: usage,
        };
      } catch (error) {
        await usage?.refund();
        throw error;
      }
    }

    const cvId = uuidv4();
    const objectKey = this.storage.buildCvObjectKey(userId, cvId, normalizedOriginalFileName);
    const targetRole = requestedRole;
    let cvSaved = false;
    let uploadCommitted = false;
    const reservations = await this.analysisQuota.reserveForUpload(userId);
    const usage = reservations.analysis;
    const uploadUsage = reservations.upload;

    try {
      await this.storage.upload({
        key: objectKey,
        body: normalizedFile.buffer,
        contentType: normalizedFile.mimetype,
      });
      const extracted = await this.extractor.extract(normalizedFile);
      let cv = await this.cvs.save(
        this.cvs.create({
          id: cvId,
          userId,
          title: requestedTitle,
          originalFileName: normalizedOriginalFileName,
          fileType: normalizedFile.mimetype,
          fileSize: normalizedFile.size,
          fileUrl: objectKey,
          contentHash,
          parsedText: extracted.text,
          cvKind: 'UPLOADED',
          targetRole,
          isOcrOnly: extracted.isOcrOnly,
        }),
      );
      cvSaved = true;
      await this.recordConsentAudit(userId, cv.id);
      await uploadUsage?.confirm({ sourceType: 'cv', sourceId: cv.id });
      uploadCommitted = Boolean(uploadUsage);

      if (!usage) {
        return {
          cv: await this.toResponse(cv, [], null),
          reviewState: 'NONE',
          reservation: null,
        };
      }

      const review = await this.reviewCv(userId, cv, targetRole ?? undefined, dto.lang);
      cv = review.cv;
      return {
        cv: await this.toResponse(cv, review.skills, review.parsed),
        reviewState: 'CREATED',
        reservation: usage,
      };
    } catch (error) {
      await usage?.refund();
      if (!uploadCommitted) {
        await uploadUsage?.refund();
        if (cvSaved) await this.cvs.delete(cvId).catch(() => undefined);
        await this.storage.delete(objectKey).catch(() => undefined);
      }
      throw error;
    }
  }

  private async refreshDuplicateUploadMetadata(
    duplicate: CvEntity,
    originalFileName: string,
    requestedTitle: string,
  ): Promise<void> {
    const existingTitle = duplicate.title?.trim() ?? '';
    const existingOriginalFileName = duplicate.originalFileName?.trim() ?? '';
    const normalizedExistingTitle = existingTitle ? normalizeCvMetadataText(existingTitle) : '';
    const normalizedExistingOriginalFileName = existingOriginalFileName
      ? normalizeCvMetadataText(existingOriginalFileName)
      : '';
    const titleWasGeneratedFromFileName =
      !existingTitle ||
      mojibakeScore(existingTitle) > 0 ||
      (Boolean(existingOriginalFileName) &&
        normalizedExistingTitle === normalizedExistingOriginalFileName);
    const update: Partial<Pick<CvEntity, 'title' | 'originalFileName'>> = {};

    if (duplicate.originalFileName !== originalFileName) {
      update.originalFileName = originalFileName;
    }
    if (titleWasGeneratedFromFileName && duplicate.title !== requestedTitle) {
      update.title = requestedTitle;
    }
    if (!Object.keys(update).length) return;

    await this.cvs.update(duplicate.id, update);
    Object.assign(duplicate, update);
  }

  async list(
    userId: string,
    options: { page: number; limit: number; cvKind?: CvKind },
  ): Promise<{ items: CvListItemDto[]; total: number; page: number; limit: number }> {
    const [items, total] = await this.cvs.findAndCount({
      where: { userId, ...(options.cvKind ? { cvKind: options.cvKind } : {}) },
      order:
        options.cvKind === 'BUILT'
          ? { updatedAt: 'DESC', createdAt: 'DESC' }
          : { createdAt: 'DESC' },
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
      this.getLatestReview(userId, cv.id),
    ]);
    return this.toResponse(cv, skills, review);
  }

  async download(userId: string, cvId: string): Promise<{ cv: CvEntity; file: DownloadedFile }> {
    const cv = await this.findOwnedCv(userId, cvId);
    if (!cv.fileUrl) {
      throw new NotFoundException({
        errorCode: ERROR_CODES.NOT_FOUND,
        message: 'Original CV file is no longer stored under the privacy retention policy',
      });
    }
    return {
      cv: {
        ...cv,
        title: cv.title ? normalizeCvMetadataText(cv.title) : null,
        originalFileName: cv.originalFileName ? normalizeCvMetadataText(cv.originalFileName) : null,
      },
      file: await this.storage.download(cv.fileUrl),
    };
  }

  async remove(userId: string, cvId: string): Promise<void> {
    const cv = await this.findOwnedCv(userId, cvId);
    if (cv.fileUrl) await this.storage.delete(cv.fileUrl).catch(() => undefined);
    await this.cvs.softDelete({ id: cvId, userId });
  }

  /**
   * Title-only rename for any owned CV. Unlike updateBuilderDraft this never touches
   * parsed_json and is not gated to BUILT, so uploaded CVs can be renamed too. Bumps
   * updated_at via save() so the library "last edited" stays accurate.
   */
  async rename(userId: string, cvId: string, title: string): Promise<RenameCvResponseDto> {
    const trimmed = normalizeCvMetadataText(title);
    if (!trimmed) {
      // Contract: explicit TITLE_REQUIRED, not a generic validation message.
      throw new BadRequestException({
        errorCode: ERROR_CODES.TITLE_REQUIRED,
        message: 'title must not be empty',
      });
    }
    const cv = await this.findOwnedCv(userId, cvId);
    // Column-scoped UPDATE, not save(entity): a full-entity save would write the parsedJson read
    // above back to the DB, so an autosave landing in between would be silently reverted —
    // the same lost-update class as the autosave/title race, in the other direction.
    await this.cvs.update(cv.id, { title: trimmed }); // bumps updated_at via @UpdateDateColumn
    const fresh = await this.findOwnedCv(userId, cvId);
    // Slim response per contract — shipping the whole canonical doc for a title change is waste.
    return {
      id: fresh.id,
      title: fresh.title,
      updatedAt: fresh.updatedAt ? fresh.updatedAt.toISOString() : null,
    };
  }

  /**
   * Snapshot the current CV document as a version. Bounds table growth by pruning old auto
   * snapshots. Beyond Reactive Resume — this is what powers version history + restore.
   */
  async createVersion(
    userId: string,
    cvId: string,
    label?: string,
    origin: CvVersionOrigin = 'MANUAL',
  ): Promise<CvVersionSummaryDto> {
    const cv = await this.findOwnedCv(userId, cvId);
    if (!cv.parsedJson) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.VALIDATION_ERROR,
        message: 'CV has no document to snapshot',
      });
    }
    const version = await this.versions.save(
      this.versions.create({
        cvId: cv.id,
        snapshot: this.cloneDocument(cv.parsedJson),
        title: cv.title,
        label: label?.trim() || null,
        origin,
      }),
    );
    await this.pruneVersions(cv.id);
    return this.toVersionSummary(version);
  }

  /** Version history, newest first, WITHOUT snapshot bodies (perf). */
  async listVersions(
    userId: string,
    cvId: string,
    page: number,
    limit: number,
  ): Promise<{ items: CvVersionSummaryDto[]; total: number; page: number; limit: number }> {
    await this.findOwnedCv(userId, cvId); // ownership gate
    const [items, total] = await this.versions.findAndCount({
      where: { cvId },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
      select: ['id', 'label', 'origin', 'title', 'createdAt'],
    });
    return { items: items.map((v) => this.toVersionSummary(v)), total, page, limit };
  }

  /** One version incl. its snapshot, for preview/diff before restore. */
  async getVersion(userId: string, cvId: string, versionId: string): Promise<CvVersionDetailDto> {
    await this.findOwnedCv(userId, cvId);
    const version = await this.findOwnedVersion(cvId, versionId);
    return { ...this.toVersionSummary(version), snapshot: version.snapshot };
  }

  /**
   * Restore a version onto the CV. Auto-snapshots the current doc first (so restore is itself
   * undoable), overwrites parsed_json, re-syncs cv_skills, and bumps updated_at via save().
   */
  async restoreVersion(userId: string, cvId: string, versionId: string): Promise<CvResponseDto> {
    await this.findOwnedCv(userId, cvId); // cheap ownership 404 before opening a transaction
    const version = await this.findOwnedVersion(cvId, versionId);
    // Atomic AND concurrency-safe: the CV row is re-read under a pessimistic lock INSIDE the
    // transaction, so a concurrent autosave can neither slip between the pre-restore snapshot
    // and the overwrite nor make that snapshot stale — snapshot + overwrite commit together
    // against the exact row state the lock observed.
    const saved = await this.versions.manager.transaction(async (em) => {
      const cv = await em.getRepository(CvEntity).findOne({
        where: { id: cvId, userId, deletedAt: IsNull() },
        lock: { mode: 'pessimistic_write' },
      });
      if (!cv) throw new NotFoundException('CV not found');
      if (cv.parsedJson) {
        await em.save(
          em.create(CvVersionEntity, {
            cvId: cv.id,
            snapshot: this.cloneDocument(cv.parsedJson),
            title: cv.title,
            label: null,
            origin: 'AUTO_PRE_RESTORE',
          }),
        );
        await this.pruneVersions(cv.id, em);
      }
      cv.parsedJson = this.cloneDocument(version.snapshot);
      cv.language = version.snapshot.language ?? cv.language;
      return em.save(cv);
    });
    await this.syncSkillsFromDoc(saved.id, saved.parsedJson!); // best-effort by design, outside tx
    return this.toResponse(saved, await this.getPersistedSkills(saved.id), null);
  }

  async createBuilderDraft(userId: string, dto: CreateBuilderCvDto): Promise<CvResponseDto> {
    const source = dto.sourceCvId
      ? await this.findOwnedCv(userId, dto.sourceCvId)
      : await this.findLatestParsedUpload(userId);

    if (dto.sourceCvId && !source?.parsedJson) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.CV_PARSE_FAILED,
        message: 'Source CV has no structured parsed data for builder prefill',
      });
    }

    const targetRole = this.normalizeTargetRole(dto.targetRole ?? source?.targetRole ?? undefined);
    this.assertSupportedTargetRole(targetRole);

    const usage = await this.entitlements.reserveUsage(userId, BillingFeatureKey.CV_BUILDER_CREATE);
    try {
      const language = dto.language ?? source?.language ?? source?.parsedJson?.language ?? 'en';
      const parsedJson = source?.parsedJson
        ? this.cloneDocument(source.parsedJson)
        : emptyCanonicalCv(language);

      const cv = await this.cvs.save(
        this.cvs.create({
          userId,
          title: dto.title?.trim() || this.defaultBuilderTitle(source),
          originalFileName: null,
          fileType: null,
          fileSize: null,
          fileUrl: null,
          parsedText: null,
          parsedJson,
          cvKind: 'BUILT',
          language,
          targetRole,
          isOcrOnly: false,
        }),
      );
      await usage.confirm({ sourceType: 'cv', sourceId: cv.id });
      return this.toResponse(cv, [], null);
    } catch (error) {
      await usage.refund();
      throw error;
    }
  }

  async updateBuilderDraft(
    userId: string,
    cvId: string,
    dto: UpdateBuilderCvDto,
  ): Promise<CvResponseDto> {
    const cv = await this.findOwnedCv(userId, cvId);
    await this.entitlements.assertFeatureIncluded(userId, BillingFeatureKey.CV_BUILDER_CREATE);
    this.assertBuiltCv(cv);

    // Column-scoped UPDATE, deliberately NOT save(entity): autosave must never write columns it
    // doesn't own. A full-entity save wrote the title read above back to the DB, so any rename
    // landing between this read and the save was silently reverted (lost update). dto.title is
    // ignored for the same reason — title is owned by rename (PATCH /api/cvs/:id); the DTO keeps
    // the field only because forbidNonWhitelisted would 400 old clients that still send it.
    const patch: Partial<CvEntity> = {
      parsedJson: this.cloneDocument(dto.parsedJson),
      language: dto.language ?? dto.parsedJson.language ?? cv.language,
    };
    if (dto.targetRole !== undefined) {
      const targetRole = this.normalizeTargetRole(dto.targetRole);
      this.assertSupportedTargetRole(targetRole);
      patch.targetRole = targetRole;
    }
    await this.cvs.update(cv.id, patch); // bumps updated_at via @UpdateDateColumn

    // Re-sync cv_skills from the edited document: job-recommendation reads cv_skills, so a builder
    // edit that adds/removes skills must not leave scoring on the pre-edit set until the next review.
    await this.syncSkillsFromDoc(cv.id, dto.parsedJson);

    const fresh = await this.findOwnedCv(userId, cvId);
    return this.toResponse(fresh, await this.getPersistedSkills(cv.id), null);
  }

  async evaluateBuilderSection(
    userId: string,
    cvId: string,
    dto: EvaluateSectionRequestDto,
  ): Promise<EvaluateSectionResponseDto> {
    await this.findOwnedCv(userId, cvId);
    return this.evaluator.evaluate(dto);
  }

  async rewriteBuilderText(
    userId: string,
    cvId: string,
    dto: RewriteRequestDto,
  ): Promise<RewriteResponseDto> {
    await this.findOwnedCv(userId, cvId);
    // Atomic charge-first reserve (quota gate before the verifier, as before): a verification
    // reject or LLM failure refunds below, so rejects still cost the user nothing.
    const usage = await this.entitlements.reserveUsage(
      userId,
      BillingFeatureKey.CV_BUILDER_REWRITE,
      {
        sourceType: 'cv',
        sourceId: cvId,
      },
    );

    let response: RewriteResponseDto;
    try {
      // PR4.5: mode='tailor' must NOT trust FE-sent skill/level. Reload the match + gap report,
      // verify ownership + the action, and let the rewriter build the instruction from the VERIFIED
      // action only.
      let verifiedAction: VerifiedTailorAction | undefined;
      if (dto.mode === 'tailor') {
        if (!dto.match_id || !dto.action_id) {
          throw new BadRequestException({
            errorCode: ERROR_CODES.VALIDATION_ERROR,
            message: 'match_id and action_id are required for tailor rewrite',
          });
        }
        if (!this.tailorVerifier) throw new Error('TailorVerifierService is not configured');
        // lang is intentionally left to the verifier's 'vi' default: the lookup key (action_id =
        // `${action_type}:${skill_canonical}`) and the anchored `before` (a verbatim CV bullet) are
        // BOTH language-independent, so the rebuilt report finds the same action regardless of lang.
        verifiedAction = await this.tailorVerifier.verify({
          userId,
          cvId,
          matchId: dto.match_id,
          actionId: dto.action_id,
          text: dto.text,
        });
      }

      // Pass the authenticated user so the ai_requests trace attributes cost/tokens to them
      // (anonymous traces are reserved for internal/calibration callers). Only forward the verified
      // action for tailor — keeping the non-tailor call shape unchanged.
      response = verifiedAction
        ? await this.rewriter.rewrite(dto, userId, verifiedAction)
        : await this.rewriter.rewrite(dto, userId);
    } catch (error) {
      await usage.refund();
      throw error;
    }
    if (response.fallback) {
      // Fallback returns the user's original text (fabricated-metric guard / empty completion) —
      // no LLM value delivered, so it stays free, matching the assistantRewrite/Extract norm.
      await usage.refund();
    }
    return response;
  }

  /** Companion Turn-1: verify ownership, then deterministically detect gaps + ask (no LLM, no quota). */
  async assistantAnalyze(
    userId: string,
    cvId: string,
    dto: AssistantAnalyzeRequestDto,
  ): Promise<CvAssistantTurn | null> {
    const cv = await this.findOwnedCv(userId, cvId);
    return cvBuilderAssistantTurn1({
      page: 'cv_builder',
      section: dto.section,
      field_path: dto.field_path,
      current_value: dto.current_value,
      locale: dto.locale ?? 'en',
      requested_action: dto.requested_action,
      target_role: cv.targetRole ?? undefined,
    });
  }

  /**
   * P3-3 "Why is this weak?" — read-only explanation from the SAME deterministic gap analysis
   * as Turn-1. No LLM, no quota, never a patch — citedSignals can't cite what wasn't detected.
   */
  async assistantExplain(
    userId: string,
    cvId: string,
    dto: AssistantExplainRequestDto,
  ): Promise<AssistantExplanation | null> {
    await this.findOwnedCv(userId, cvId);
    return buildCvAssistantExplanation({
      page: 'cv_builder',
      section: dto.section,
      field_path: dto.field_path,
      current_value: dto.current_value,
      locale: dto.locale ?? 'en',
    });
  }

  /**
   * Companion Turn-1.5: role-aware smart questions (LLM, opt-in). Verifies ownership, then reads
   * `target_role` from the CV record ITSELF (never from the request body) and delegates to the
   * generator, which always resolves — any LLM/parse miss degrades to the same deterministic Turn-1
   * rule questions, so this endpoint never goes silent. No quota is charged here; abuse is bounded
   * by the controller's rate limit (same shape as /rewrite).
   */
  async assistantSmartQuestions(
    userId: string,
    cvId: string,
    dto: AssistantSmartQuestionsRequestDto,
  ): Promise<CvAssistantTurn> {
    const cv = await this.findOwnedCv(userId, cvId);
    if (!this.questionGenerator) throw new Error('CvQuestionGeneratorService is not configured');
    return this.questionGenerator.generate(
      {
        page: 'cv_builder',
        section: dto.section,
        field_path: dto.field_path,
        current_value: dto.current_value,
        locale: dto.locale ?? 'en',
        requested_action: dto.requested_action,
        target_role: cv.targetRole ?? undefined,
      },
      userId,
    );
  }

  /**
   * Story→CV slice 1 — infer a career target from a free narrative. Deterministic (no LLM, no quota).
   * Ownership-checked: the story is scoped to the user's own draft. Abstains honestly (200 +
   * needs_user_input) when the signal is too weak/ambiguous — never fabricates a role.
   */
  async inferCareerTargetFromStory(
    userId: string,
    cvId: string,
    dto: CareerTargetStoryRequestDto,
  ): Promise<CareerTargetStoryResponseDto> {
    await this.findOwnedCv(userId, cvId);
    const r = this.roleInference.inferFromStory(dto.story, dto.language ?? 'vi');
    return {
      role_code: r.role_code,
      display_name: r.display_name,
      confidence: r.confidence,
      matched_skills: r.matched_skills,
      candidates: r.candidates.map((c) => ({
        role_code: c.role_code,
        display_name: c.display_name,
        score: c.score,
      })),
      needs_user_input: r.needs_user_input,
      reason: r.reason,
    };
  }

  /** Story→CV slice 3 — stateless merge preview. Ownership-checked; NO persist (caller PUTs the result),
   *  NO quota, NO LLM. Deterministic dedup; never overwrites or duplicates existing entries. */
  async applyStoryPreview(
    userId: string,
    cvId: string,
    dto: StoryApplyRequestDto,
  ): Promise<StoryApplyResponseDto> {
    await this.findOwnedCv(userId, cvId);
    return mergeStoryItems(dto.doc, dto.selected);
  }

  /**
   * Story→CV slice 2 — extract projects + certifications from a free narrative. Certs are pure-code
   * (always free); projects use one grounded LLM call. Charges CV_BUILDER_REWRITE quota only when the
   * project extraction is non-degraded AND grounds at least one project — a degraded fallback or a
   * cert-only story delivered no LLM value.
   */
  async extractProjectsCertsFromStory(
    userId: string,
    cvId: string,
    dto: StoryExtractRequestDto,
  ): Promise<StoryExtractResponseDto> {
    await this.findOwnedCv(userId, cvId);
    const usage = await this.entitlements.reserveUsage(
      userId,
      BillingFeatureKey.CV_BUILDER_REWRITE,
      {
        sourceType: 'cv',
        sourceId: cvId,
      },
    );
    let result: StoryExtractResponseDto;
    try {
      result = await this.storyExtraction.extract(dto.story, dto.language ?? 'vi', userId);
    } catch (error) {
      await usage.refund();
      throw error;
    }
    // A non-degraded call that still grounds ZERO projects delivered no LLM value (e.g. cert-only
    // story) — must stay free, matching the "no LLM value = free" norm used by assistantRewrite/Extract.
    if (result.degraded || result.projects.length === 0) {
      await usage.refund();
    }
    return result;
  }

  /** Story→CV project intake — one project for one CV card. Reuses the anti-fab extractor. Charges
   *  CV_BUILDER_REWRITE only when a project was actually grounded (degraded / nothing-grounded = free). */
  async intakeProjectFromStory(
    userId: string,
    cvId: string,
    dto: ProjectIntakeRequestDto,
  ): Promise<ProjectIntakeResponseDto> {
    await this.findOwnedCv(userId, cvId);
    const usage = await this.entitlements.reserveUsage(
      userId,
      BillingFeatureKey.CV_BUILDER_REWRITE,
      {
        sourceType: 'cv',
        sourceId: cvId,
      },
    );
    let extracted: Awaited<ReturnType<StoryExtractionService['extractProject']>>;
    try {
      extracted = await this.storyExtraction.extractProject(
        dto.story,
        dto.language ?? 'vi',
        userId,
      );
    } catch (error) {
      await usage.refund();
      throw error;
    }
    const { project, degraded, multipleDetected } = extracted;
    if (degraded || project == null) {
      await usage.refund();
    }
    return { project, degraded, multiple_detected: multipleDetected };
  }

  /**
   * Story→CV slice 4 — close the loop: rubric-only gap (full canonical GapItems) + readiness from the
   * doc's structured skills. Deterministic (no LLM, no quota, no persist). Honest: a role with no rubric
   * → readiness 0, empty gap. Readiness uses the UNCAPPED raw weighted score to avoid double-counting
   * coverage (overall_score already embeds coverage via the cap).
   */
  async computeStoryReadiness(
    userId: string,
    cvId: string,
    dto: StoryReadinessRequestDto,
  ): Promise<StoryReadinessResponseDto> {
    const cv = await this.findOwnedCv(userId, cvId);
    const doc = cv.parsedJson ?? emptyCanonicalCv(cv.language ?? 'en');
    const cvSkills = cvSkillsFromDoc(doc);
    const diff = this.skillDiff.diff({
      cv_skills_raw: cvSkills,
      target_role: dto.role_code,
      target_band: dto.band ?? 'fresher',
    });

    // A role with no rubric at all is a vacuous case: SkillDiffService.diff falls back to
    // required_coverage=1 ("nothing required ⇒ all covered"), which would otherwise feed
    // computeReadiness into reporting a dishonest non-zero readiness for a role the system has
    // ZERO data on. Detect that case BEFORE computing readiness so the response can be an honest
    // empty state instead.
    // ponytail: gate on skill-count — airtight for all 18 curated rubrics (each has ≥5 REQUIRED skills, so a
    // rubric always implies requiredTotal>0). A future rubric with ZERO REQUIRED skills would slip past this and
    // surface vacuous readiness 40 / coverage 1.0; harden to diff.scoring_breakdown.required_total > 0 if that ever ships.
    const role_has_rubric =
      diff.matched_skills.length + diff.missing_skills.length + diff.partial_skills.length > 0;

    // Readiness from the UNCAPPED raw weighted score (NOT overall_score — that already embeds
    // coverage via min(raw, 45+55·coverage), which would double-count coverage in the
    // missing-required regime). Fall back to overall_score alone only if raw is somehow absent.
    const rawScore = diff.scoring_breakdown?.raw_weighted_score ?? diff.overall_score;
    const { readiness, band } = role_has_rubric
      ? computeReadiness(rawScore, diff.required_coverage)
      : { readiness: 0, band: 'starting' as const };
    const required_coverage = role_has_rubric ? diff.required_coverage : 0;

    // Full canonical GapItems via buildGapItems, mirroring the DiffResult → CvJdMatchParsedResponse
    // adapter in cv-jd-match.service.ts (same field names; requirements_source renamed to
    // source_of_requirements). No cast needed — every DiffResult field buildGapItems reads exists
    // on CvJdMatchParsedResponse with an identical type.
    const match: CvJdMatchParsedResponse = {
      // ponytail: builder-readiness keeps the legacy 0 when the role has no rubric (source none);
      // honest-null for the builder surface is out of TRUST scope — ledgered for a later wave.
      overall_score: diff.overall_score ?? 0,
      match_ratio: diff.match_ratio,
      matched_skills: diff.matched_skills,
      partial_skills: diff.partial_skills,
      missing_skills: diff.missing_skills,
      bonus_skills: diff.bonus_skills,
      required_coverage: diff.required_coverage,
      unnormalized_cv_skills: diff.unnormalized_cv_skills,
      unnormalized_jd_requirements: diff.unnormalized_jd_requirements,
      scoring_breakdown: diff.scoring_breakdown,
      source_of_requirements: diff.requirements_source,
      target_role: dto.role_code ?? null,
      rubric_band: diff.rubric_band,
    };
    const gap_items = buildGapItems({ match }); // severity-sorted, fixability, requirement_id

    return {
      readiness,
      band,
      overall_score: diff.overall_score ?? 0,
      required_coverage,
      matched_count: diff.matched_skills.length,
      missing_count: diff.missing_skills.length,
      gap_items,
      roadmap_pointer: {
        route: 'POST /api/cv-matches/:matchId/roadmap',
        payload: {
          hint: 'create a match for this role, then compose a roadmap from the gap',
          role_code: dto.role_code,
        },
      },
      role_has_rubric,
    };
  }

  /**
   * Companion Turn-2: verify ownership + quota, then ground-rewrite one bullet. A delivered patch
   * consumes CV_BUILDER_REWRITE quota; a re-ask / degraded / ungrounded response is free (no LLM value).
   */
  async assistantRewrite(
    userId: string,
    cvId: string,
    dto: AssistantRewriteRequestDto,
  ): Promise<CvAssistantRewriteResult> {
    await this.findOwnedCv(userId, cvId);
    if (!this.cvAssistant) throw new Error('CvAssistantRewriteService is not configured');
    const language = dto.locale ?? 'en';
    // A re-ask (missing/insufficient detail) spends NO LLM and must stay free — gate quota only when a
    // rewrite will actually run, so an out-of-quota user can still get the "tell me more" follow-up.
    // Ground with the SAME language the engine uses (output_lang) so the charge decision can never
    // diverge from the rewrite's own re-ask gate.
    const grounded = groundCvAssistantAnswers(dto.answers, dto.output_lang ?? language);
    // A transform intent (improve/shorten/…) rewrites from the original bullet alone, so it runs
    // the LLM even with zero answer facts — mirror the engine's isTransformIntent gate exactly.
    const willRunRewrite =
      grounded.needs_detail.length === 0 && (grounded.facts.length > 0 || Boolean(dto.intent));
    const usage = willRunRewrite
      ? await this.entitlements.reserveUsage(userId, BillingFeatureKey.CV_BUILDER_REWRITE, {
          sourceType: 'cv',
          sourceId: cvId,
        })
      : null;
    let result: CvAssistantRewriteResult;
    try {
      result = await this.cvAssistant.rewrite(
        {
          before: dto.before,
          answers: dto.answers,
          target: dto.target,
          language,
          outputLang: dto.output_lang ?? language,
          kind: dto.kind ?? 'bullet',
          tone: dto.tone,
          intent: dto.intent,
        },
        userId,
      );
    } catch (error) {
      await usage?.refund();
      throw error;
    }
    if (usage && !result.ok) {
      await usage.refund();
    }
    return result;
  }

  /** Companion (skills section): deterministic completeness nudges from the draft's skills. No quota, no LLM. */
  async assistantSkillsNudge(
    userId: string,
    cvId: string,
    language: 'vi' | 'en',
  ): Promise<SkillsNudge[]> {
    const cv = await this.findOwnedCv(userId, cvId);
    return analyzeSkillsSection((cv.parsedJson?.skills ?? {}) as SkillsSection, language);
  }

  /**
   * Narrative intake (Phase 1: experience): verify ownership + quota, then turn the user's free-text
   * story into structured fields. CV_BUILDER_REWRITE quota is charged only on a non-degraded
   * extraction (a degraded fallback delivered no value). `output_lang` defaults to `locale` (the CV
   * language follows the UI language unless the caller states otherwise).
   */
  async assistantExtract(
    userId: string,
    cvId: string,
    dto: ExtractRequestDto,
  ): Promise<CvIntakeResult> {
    await this.findOwnedCv(userId, cvId);
    if (!this.cvIntake) throw new Error('CvIntakeService is not configured');
    const locale = dto.locale ?? 'en';
    const usage = await this.entitlements.reserveUsage(
      userId,
      BillingFeatureKey.CV_BUILDER_REWRITE,
      {
        sourceType: 'cv',
        sourceId: cvId,
      },
    );
    let result: CvIntakeResult;
    try {
      result = await this.cvIntake.extract(
        {
          section: dto.section,
          narrative: dto.narrative,
          locale,
          outputLang: dto.output_lang ?? locale,
        },
        userId,
      );
    } catch (error) {
      await usage.refund();
      throw error;
    }
    if (result.degraded) {
      await usage.refund();
    }
    return result;
  }

  async renderPdf(userId: string, cvId: string): Promise<RenderedCvPdf> {
    const cv = await this.findOwnedCv(userId, cvId);
    this.assertBuiltCv(cv);
    if (!cv.parsedJson) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.CV_PARSE_FAILED,
        message: 'CV has no structured builder data to render',
      });
    }
    const usage = await this.entitlements.reserveUsage(
      userId,
      BillingFeatureKey.CV_BUILDER_RENDER_PDF,
    );
    try {
      const rendered = await this.pdfRenderer.renderHarvardPdf(cv);
      await usage.confirm({ sourceType: 'cv', sourceId: cv.id });
      return rendered;
    } catch (error) {
      await usage.refund();
      throw error;
    }
  }

  async getInterviewPlan(
    userId: string,
    cvId: string,
    role: string | null | undefined,
    lang: 'vi' | 'en' = 'vi',
  ): Promise<InterviewPlanResponseDto> {
    const targetRole = this.normalizeTargetRole(role);
    if (!targetRole) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.VALIDATION_ERROR,
        message: 'role query parameter is required',
      });
    }
    await this.findOwnedCv(userId, cvId);
    const review = await this.getLatestReview(userId, cvId);
    if (!review) {
      throw new NotFoundException({
        errorCode: ERROR_CODES.NOT_FOUND,
        message: 'Run CV diagnosis before generating an interview plan',
      });
    }
    if (!this.interviewPlan) {
      throw new Error('InterviewPlanService is not configured');
    }

    return this.interviewPlan.generatePlan(userId, {
      review,
      target_role: targetRole,
      lang,
    });
  }

  async getGithubEvidence(
    userId: string,
    cvId: string,
    username: string,
    consent: boolean,
    lang: 'vi' | 'en' = 'vi',
  ): Promise<GithubEvidenceDto> {
    await this.findOwnedCv(userId, cvId);
    if (!this.githubEvidence) {
      throw new Error('GithubEvidenceService is not configured');
    }
    return this.githubEvidence.build({
      username,
      consent,
      review: await this.getLatestReview(userId, cvId),
      lang,
    });
  }

  async rerunReview(
    userId: string,
    cvId: string,
    requestedRole?: string,
    lang?: 'vi' | 'en',
  ): Promise<CvResponseDto> {
    const result = await this.rerunReviewForAnalysis(userId, cvId, requestedRole, lang);
    await result.reservation?.confirm({ sourceType: 'cv', sourceId: result.cv.id });
    return result.cv;
  }

  async rerunReviewForAnalysis(
    userId: string,
    cvId: string,
    requestedRole?: string,
    lang?: 'vi' | 'en',
  ): Promise<PreparedCvAnalysis> {
    const cv = await this.findOwnedCv(userId, cvId);
    const parsedText = this.reviewableText(cv);
    if (!parsedText) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.CV_PARSE_FAILED,
        message: 'CV has no parsed text to review',
      });
    }

    // The caller may pick a NEW role (e.g. re-scan as Data Analyst); fall back to the CV's
    // stored role when none is given. Reuse a cached analysis only for THAT role — a different
    // role re-grades against its own rubric instead of returning the stored role's review.
    const role = this.normalizeTargetRole(requestedRole) ?? cv.targetRole ?? null;
    this.assertSupportedTargetRole(role);
    // Reuse a cached review ONLY when its feedback language matches what the caller asked for
    // (a UI-locale toggle must re-generate, not serve the previous language). `lang` undefined =
    // old behavior (matches the null-lang bucket).
    const cached = await this.getLatestMatchingReview(userId, cv.id, role, lang);
    if (cached) {
      return {
        cv: await this.toResponse(cv, await this.getPersistedSkills(cv.id), cached),
        reviewState: 'CACHED',
        reservation: null,
      };
    }

    cv.parsedText = parsedText;
    if (role && role !== cv.targetRole) {
      cv.targetRole = role;
      // Column-scoped: a full-entity save would write back the whole row read above and could
      // revert a concurrent rename/autosave (the lost-update class fixed across this service).
      await this.cvs.update(cv.id, { targetRole: role });
    }
    const usage = await this.analysisQuota.reserveAnalysis(userId);
    try {
      const review = await this.reviewCv(userId, cv, role ?? undefined, lang);
      return {
        cv: await this.toResponse(review.cv, review.skills, review.parsed),
        reviewState: 'CREATED',
        reservation: usage,
      };
    } catch (error) {
      await usage?.refund();
      throw error;
    }
  }

  private async reviewCv(
    userId: string,
    cv: CvEntity,
    targetRole?: string,
    lang?: 'vi' | 'en',
  ): Promise<{ cv: CvEntity; parsed: CvReviewParsedResponse; skills: CvSkillResponseDto[] }> {
    if (!cv.parsedText) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.CV_PARSE_FAILED,
        message: 'CV parsed text is missing',
      });
    }

    const effectiveTargetRole = this.normalizeTargetRole(targetRole ?? cv.targetRole ?? undefined);
    // Identity basis for the post-model write: the document as it was when this analysis
    // started. If it changes during the multi-second model call (autosave, restore), the
    // fresher document wins and this review's write yields — same invariant as
    // syncSkillsFromDoc: cv_skills must always represent the stored parsed_json.
    const preReviewDoc = cv.parsedJson ?? null;

    const review = await this.cvReview.review(userId, {
      cv_id: cv.id,
      parsed_text: cv.parsedText,
      prompt_template_code: CV_REVIEW_PROMPT_CODE,
      target_role: effectiveTargetRole ?? undefined,
      mime_type: cv.fileType ?? undefined,
      is_ocr_only: cv.isOcrOnly,
      lang,
    });
    const parsed = review.parsed_response;

    // Normalize outside the lock — it can call the embedding service (network).
    const normalized = await this.normalizeRawSkills(parsed.ats_extracted.skills_raw ?? []);

    // One identity-guarded transaction, column-scoped writes: parsed_json and cv_skills commit
    // together, so an analyze racing a restore/autosave can never leave them representing
    // different documents. The previous full-entity save also resurrected the pre-model title
    // and document — the same lost-update class fixed for autosave and rename.
    const reviewPatch = {
      parsedText: cv.parsedText,
      parsedJson: parsed.document,
      language: parsed.language,
      atsReadabilityScore: parsed.ats_rule_score.toFixed(2),
      targetRole: effectiveTargetRole,
    };
    let lockedCv: CvEntity | null = null;
    const skills = await this.cvs.manager.transaction(async (em) => {
      lockedCv = await em.getRepository(CvEntity).findOne({
        where: { id: cv.id, deletedAt: IsNull() },
        lock: { mode: 'pessimistic_write' },
      });
      if (!lockedCv || !isDeepStrictEqual(lockedCv.parsedJson ?? null, preReviewDoc)) return null;
      await em.getRepository(CvEntity).update(cv.id, reviewPatch);
      // Mirror the UPDATE onto the locked entity for the response (TypeORM sets the
      // @UpdateDateColumn client-side the same way).
      Object.assign(lockedCv, reviewPatch, { updatedAt: new Date() });
      return this.writeNormalizedSkills(cv.id, normalized, em);
    });

    if (!lockedCv) throw new NotFoundException('CV not found');
    if (skills === null) {
      this.logger.warn(
        `cv review persist skipped for cv ${cv.id} — the document changed during analysis; the fresher document wins`,
      );
      return { cv: lockedCv, parsed, skills: await this.getPersistedSkills(cv.id) };
    }
    return { cv: lockedCv, parsed, skills };
  }

  /** Normalization can hit the embedding service (network) — keep it OUTSIDE any DB lock. */
  private normalizeRawSkills(rawSkills: string[]) {
    const uniqueRawSkills = [...new Set(rawSkills.map((s) => s.trim()).filter(Boolean))];
    // Async variant = deterministic cascade + embedding fallback for the long tail
    // (semantic tier fires only on full cascade misses; no-ops in test/keyless envs).
    return this.skillNormalizer.normalizeManyAsync(uniqueRawSkills);
  }

  private async writeNormalizedSkills(
    cvId: string,
    normalized: Awaited<ReturnType<SkillNormalizerService['normalizeManyAsync']>>,
    em?: EntityManager,
  ): Promise<CvSkillResponseDto[]> {
    const canonicalNames = [
      ...new Set(
        normalized
          .map((skill) => skill.canonical_name)
          .filter((value): value is string => typeof value === 'string' && value.length > 0),
      ),
    ];

    const skillsRepository = em ? em.getRepository(SkillEntity) : this.skills;
    const cvSkillsRepository = em ? em.getRepository(CvSkillEntity) : this.cvSkills;
    const entities =
      canonicalNames.length > 0
        ? await skillsRepository.find({ where: { canonicalName: In(canonicalNames) } })
        : [];
    const entityByCanonical = new Map(entities.map((skill) => [skill.canonicalName, skill]));

    await cvSkillsRepository.delete({ cvId });
    const rowsBySkillId = new Map<string, CvSkillEntity>();
    for (const skill of normalized) {
      if (!skill.canonical_name) continue;
      const entity = entityByCanonical.get(skill.canonical_name);
      if (!entity) continue;
      const row = cvSkillsRepository.create({
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
    if (rows.length > 0) await cvSkillsRepository.save(rows);

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

  async getLatestReview(userId: string, cvId: string): Promise<CvReviewParsedResponse | null> {
    const rows = (await this.aiResults.manager.query(
      `
        SELECT ar.parsed_response, ar.confidence_score
        FROM ai_results ar
        INNER JOIN ai_requests req ON req.id = ar.ai_request_id
        INNER JOIN cvs c
          ON c.id = (req.request_payload -> 'payload' ->> 'cv_id')::uuid
         AND c.user_id = ar.user_id
         AND c.deleted_at IS NULL
        WHERE ar.user_id = $1
          AND ar.result_type = $2
          AND req.request_payload -> 'payload' ->> 'cv_id' = $3
        ORDER BY ar.created_at DESC
        LIMIT 1
      `,
      [userId, BillingFeatureKey.CV_REVIEW, cvId],
    )) as Array<{
      parsed_response: CvReviewParsedResponse | null;
      confidence_score: string | null;
    }>;

    const row = rows[0];
    if (!row?.parsed_response) return null;
    // Re-attach the persisted confidence signal (numeric comes back as a string from pg) —
    // previously dropped on every cached read while the live compute path surfaced it.
    return {
      ...row.parsed_response,
      confidence_score: row.confidence_score != null ? Number(row.confidence_score) : null,
    };
  }

  private async getLatestMatchingReview(
    userId: string,
    cvId: string,
    targetRole: string | null,
    lang?: 'vi' | 'en',
  ): Promise<CvReviewParsedResponse | null> {
    // All four predicates read the SAME nested `payload` object that cv-review.service writes
    // (cv_id, target_role, prompt_template_code='cv_review_v1'). The TOP-LEVEL
    // prompt_template_code is the bare 'cv_review' (the loader strips the _v1 suffix into a
    // separate version), so filtering it against the combined CV_REVIEW_PROMPT_CODE never
    // matched — this query returned 0 rows for every call, silently disabling the cache.
    // The combined code already encodes the version, so no separate version predicate is needed.
    // Null role is its OWN bucket (IS NOT DISTINCT FROM): a role-less scan must not reuse a
    // role-specific analysis (its skills_relevance was graded against that role's rubric).
    const rows = (await this.aiResults.manager.query(
      `
        SELECT ar.parsed_response, ar.confidence_score
        FROM ai_results ar
        INNER JOIN ai_requests req ON req.id = ar.ai_request_id
        WHERE ar.user_id = $1
          AND ar.result_type = $2
          AND req.request_payload -> 'payload' ->> 'cv_id' = $3
          AND req.request_payload -> 'payload' ->> 'target_role' IS NOT DISTINCT FROM $4
          AND req.request_payload -> 'payload' ->> 'prompt_template_code' = $5
          AND req.request_payload -> 'payload' ->> 'lang' IS NOT DISTINCT FROM $6
        ORDER BY ar.created_at DESC
        LIMIT 1
      `,
      [userId, BillingFeatureKey.CV_REVIEW, cvId, targetRole, CV_REVIEW_PROMPT_CODE, lang ?? null],
    )) as Array<{ parsed_response: CvReviewParsedResponse | null; confidence_score?: unknown }>;

    const row = rows[0];
    if (!row?.parsed_response) return null;
    // Same re-attach as getLatestReview — the cache-reuse path must not be the one place a
    // review loses its confidence_score (review finding I1).
    return row.confidence_score != null
      ? { ...row.parsed_response, confidence_score: Number(row.confidence_score) }
      : row.parsed_response;
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

  private assertSupportedTargetRole(role: string | null): void {
    // At runtime Nest always injects RoleRubricService. The undefined branch exists only for old
    // direct-constructor tests that do not exercise role-bearing paths.
    if (!role || !this.roleRubrics || this.roleRubrics.hasRubric(role)) return;
    throw new BadRequestException({
      errorCode: 'UNSUPPORTED_TARGET_ROLE',
      message: `Unsupported target role: ${role}`,
    });
  }
  private async findGeneratedPdfSource(
    userId: string,
    file: Express.Multer.File,
  ): Promise<CvEntity | null> {
    const sourceCvId = await this.pdfRenderer.extractSkillbridgeFingerprint(file);
    if (!sourceCvId) return null;
    return this.cvs.findOne({
      where: { id: sourceCvId, userId, deletedAt: IsNull() },
    });
  }

  private async findDuplicateContentHash(
    userId: string,
    contentHash: string,
  ): Promise<CvEntity | null> {
    return this.cvs.findOne({
      where: { userId, contentHash, deletedAt: IsNull() },
      order: { createdAt: 'DESC' },
    });
  }

  private reviewableText(cv: CvEntity): string | null {
    if (cv.parsedText?.trim()) return cv.parsedText;
    if (cv.cvKind === 'BUILT' && cv.parsedJson) {
      const text = documentToPlainText(cv.parsedJson);
      return text.trim() ? text : null;
    }
    return null;
  }

  private sha256(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex');
  }

  private async findLatestParsedUpload(userId: string): Promise<CvEntity | null> {
    return this.cvs.findOne({
      where: {
        userId,
        cvKind: 'UPLOADED',
        parsedJson: Not(IsNull()),
        deletedAt: IsNull(),
      },
      order: { createdAt: 'DESC' },
    });
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
    const cv = await this.cvs.findOne({ where: { id: cvId, userId, deletedAt: IsNull() } });
    if (!cv) throw new NotFoundException('CV not found');
    return cv;
  }

  /**
   * Public read for the CV-builder chat platform layer — ownership-gated (throws NotFoundException via
   * findOwnedCv if not owned), returns the draft doc + target_role server-side so the FE can never inject
   * a role/fact through the chat DTO.
   */
  async getOwnedCvForChat(
    userId: string,
    cvId: string,
  ): Promise<{ document: CanonicalCvDocument; targetRole: string | null; language: string }> {
    const cv = await this.findOwnedCv(userId, cvId);
    return {
      document: cv.parsedJson ?? emptyCanonicalCv(cv.language ?? 'en'),
      targetRole: cv.targetRole ?? null,
      language: cv.language ?? cv.parsedJson?.language ?? 'en',
    };
  }

  private assertBuiltCv(cv: CvEntity): void {
    if (cv.cvKind !== 'BUILT') {
      throw new BadRequestException({
        errorCode: ERROR_CODES.VALIDATION_ERROR,
        message: 'This operation is only available for CV builder drafts',
      });
    }
  }

  private defaultBuilderTitle(source: CvEntity | null): string {
    if (source?.title?.trim()) return `${source.title.trim()} Builder`;
    return 'Builder CV';
  }

  private cloneDocument(document: CanonicalCvDocument): CanonicalCvDocument {
    return JSON.parse(JSON.stringify(document)) as CanonicalCvDocument;
  }

  private async toResponse(
    cv: CvEntity,
    skills: CvSkillResponseDto[],
    review: CvReviewParsedResponse | null,
  ): Promise<CvResponseDto> {
    const premiumView = review
      ? diagnosisPremiumView(
          review,
          await this.entitlements.hasActivePlan(cv.userId, BillingPlanCode.PREMIUM),
        )
      : null;

    return {
      id: cv.id,
      title: cv.title ? normalizeCvMetadataText(cv.title) : null,
      originalFileName: cv.originalFileName ? normalizeCvMetadataText(cv.originalFileName) : null,
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
      review: premiumView?.review ?? null,
      premiumDetails: premiumView?.premiumDetails ?? null,
      createdAt: cv.createdAt.toISOString(),
      updatedAt: cv.updatedAt ? cv.updatedAt.toISOString() : null,
    };
  }

  private toListItem(cv: CvEntity): CvListItemDto {
    return {
      id: cv.id,
      title: cv.title ? normalizeCvMetadataText(cv.title) : null,
      originalFileName: cv.originalFileName ? normalizeCvMetadataText(cv.originalFileName) : null,
      fileType: cv.fileType,
      fileSize: cv.fileSize,
      cvKind: cv.cvKind,
      language: cv.language,
      targetRole: cv.targetRole,
      isOcrOnly: cv.isOcrOnly,
      atsReadabilityScore: cv.atsReadabilityScore ? Number(cv.atsReadabilityScore) : null,
      createdAt: cv.createdAt.toISOString(),
      updatedAt: cv.updatedAt ? cv.updatedAt.toISOString() : null,
    };
  }

  /** Version repo — guaranteed at runtime by CvsModule; guards against a mis-wired module. */
  private get versions(): Repository<CvVersionEntity> {
    if (!this.cvVersions) throw new Error('CvVersionEntity repository is not injected');
    return this.cvVersions;
  }

  private async findOwnedVersion(cvId: string, versionId: string): Promise<CvVersionEntity> {
    const version = await this.versions.findOne({ where: { id: versionId, cvId } });
    if (!version) throw new NotFoundException('CV version not found');
    return version;
  }

  /**
   * Bound table growth: keep the newest N of each origin class per CV (auto snapshots = 20,
   * manual/labeled = 50). Without the manual cap the table grows unbounded on repeated
   * "Save version". ponytail: fixed caps; raise if users ask for deeper history.
   */
  private async pruneVersions(cvId: string, em?: EntityManager): Promise<void> {
    await this.pruneOrigin(cvId, ['AUTO_PRE_RESTORE', 'AUTO_PRE_IMPORT'], 20, em);
    await this.pruneOrigin(cvId, ['MANUAL'], 50, em);
  }

  private async pruneOrigin(
    cvId: string,
    origins: CvVersionOrigin[],
    keep: number,
    em?: EntityManager,
  ): Promise<void> {
    const repo = em ? em.getRepository(CvVersionEntity) : this.versions;
    const rows = await repo.find({
      where: { cvId, origin: In(origins) },
      order: { createdAt: 'DESC' },
      select: ['id'],
    });
    const stale = rows.slice(keep).map((v) => v.id);
    if (stale.length > 0) await repo.delete({ id: In(stale) });
  }

  private toVersionSummary(v: CvVersionEntity): CvVersionSummaryDto {
    return {
      id: v.id,
      label: v.label,
      origin: v.origin,
      title: v.title,
      createdAt: v.createdAt.toISOString(),
    };
  }

  /**
   * Re-sync cv_skills from a canonical doc (best-effort). job-recommendation reads cv_skills, so a
   * builder save/restore that changes skills must not leave scoring on the stale set. A sync failure
   * degrades to the previous set (warn) — it must never fail the caller.
   */
  private async syncSkillsFromDoc(cvId: string, doc: CanonicalCvDocument): Promise<void> {
    try {
      const rawSkills = [
        ...(doc.skills?.technical ?? []),
        ...(doc.skills?.soft ?? []),
        ...(doc.skills?.languages ?? []),
        ...(doc.skills?.tools ?? []),
      ];
      // Normalize BEFORE taking the row lock — it can call the embedding service, and a DB
      // lock must never span a network call (autosave, rename, and restore all queue on
      // this row; a slow embedding tier would serialize them all behind it).
      const normalized = await this.normalizeRawSkills(rawSkills);
      await this.cvs.manager.transaction(async (em) => {
        // Persisted derived skills must belong to the exact document currently stored. A restore
        // can replace parsedJson while an earlier autosave is still waiting to sync; locking the
        // CV row and rejecting a document mismatch prevents that stale autosave from winning.
        const current = await em.getRepository(CvEntity).findOne({
          where: { id: cvId, deletedAt: IsNull() },
          lock: { mode: 'pessimistic_write' },
        });
        if (!current || !isDeepStrictEqual(current.parsedJson, doc)) return;
        await this.writeNormalizedSkills(cvId, normalized, em);
      });
    } catch (err) {
      this.logger.warn(
        `builder skill sync failed for cv ${cvId} — job-rec will read the previous set: ${(err as Error).message}`,
      );
    }
  }
}

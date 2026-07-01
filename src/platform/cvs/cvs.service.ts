import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { In, IsNull, MoreThanOrEqual, Not, Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { BillingFeatureKey } from '../../common/constants/billing.constants';
import { CanonicalCvDocument, emptyCanonicalCv } from '../../common/types/canonical-cv';
import { AiResultEntity } from '../../database/entities/ai-result.entity';
import { CvConsentAuditEntity } from '../../database/entities/cv-consent-audit.entity';
import { CvEntity } from '../../database/entities/cv.entity';
import { CvSkillEntity } from '../../database/entities/cv-skill.entity';
import { SkillEntity } from '../../database/entities/skill.entity';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { documentToPlainText } from '../../common/services/cv-document-text';
import { SkillNormalizerService } from '../../common/services/skill-normalizer.service';
import { EntitlementsService } from '../billing/entitlements.service';
import {
  CvAssistantRewriteService,
  CvAssistantRewriteResult,
} from '../../modules/cv-assistant/cv-assistant.service';
import { groundCvAssistantAnswers } from '../../modules/cv-assistant/cv-assistant-rewrite';
import { cvBuilderAssistantTurn1, CvAssistantTurn } from '../../modules/cv-assistant/cv-assistant';
import {
  analyzeSkillsSection,
  SkillsNudge,
  SkillsSection,
} from '../../modules/cv-assistant/cv-assistant-skills';
import {
  AssistantAnalyzeRequestDto,
  AssistantRewriteRequestDto,
  ExtractRequestDto,
} from './dto/cv-assistant.dto';
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
import { CvListItemDto, CvResponseDto, CvSkillResponseDto } from './dto/cv-response.dto';
import { CvPdfRendererService, RenderedCvPdf } from './cv-pdf-renderer.service';
import { TextExtractorService } from './text-extractor.service';
import { CvAnalysisQuotaService } from './cv-analysis-quota.service';

const MAX_CV_FILE_BYTES = 5 * 1024 * 1024;
const MAX_REAL_UPLOADS_PER_DAY = 10;
const CV_PROCESSING_CONSENT_VERSION = 'cv-processing-v1';
const CV_UPLOAD_CONSENT_SOURCE = 'cv_upload';
const CV_REVIEW_PROMPT_CODE = 'cv_review_v1';
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

    const generatedSource = await this.findGeneratedPdfSource(userId, file);
    if (generatedSource) {
      const role = this.normalizeTargetRole(dto.targetRole) ?? generatedSource.targetRole ?? null;
      const cached = await this.getLatestMatchingReview(userId, generatedSource.id, role);
      if (cached) {
        return this.toResponse(
          generatedSource,
          await this.getPersistedSkills(generatedSource.id),
          cached,
        );
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
        await this.cvs.save(generatedSource);
      }
      await this.analysisQuota.assertWithinDailyLimit(userId);
      const review = await this.reviewCv(userId, generatedSource, role ?? undefined);
      await this.analysisQuota.recordSuccessfulAnalysis(userId, generatedSource.id);
      return this.toResponse(review.cv, review.skills, review.parsed);
    }

    const contentHash = this.sha256(file.buffer);
    const duplicate = await this.findDuplicateContentHash(userId, contentHash);
    if (duplicate) {
      // Role-aware dedup: the review is scored against the TARGET ROLE's rubric
      // (skills_relevance + skill breakdown), so reuse a prior analysis ONLY when one
      // exists for the requested role. Re-uploading the same file under a NEW role must
      // re-grade — otherwise the user sees the previous role's analysis on a fast-but-wrong
      // scan. A request without a role (null) matches the latest analysis of any role.
      const requestedRole = this.normalizeTargetRole(dto.targetRole);
      const cachedForRole = await this.getLatestMatchingReview(
        userId,
        duplicate.id,
        requestedRole ?? null,
      );
      if (cachedForRole) {
        return this.toResponse(
          duplicate,
          await this.getPersistedSkills(duplicate.id),
          cachedForRole,
        );
      }
      await this.analysisQuota.assertWithinDailyLimit(userId);
      if (requestedRole && requestedRole !== duplicate.targetRole) {
        duplicate.targetRole = requestedRole;
        await this.cvs.save(duplicate);
      }
      const review = await this.reviewCv(userId, duplicate, requestedRole ?? undefined);
      await this.analysisQuota.recordSuccessfulAnalysis(userId, duplicate.id);
      return this.toResponse(review.cv, review.skills, review.parsed);
    }

    await this.enforceUploadQuota(userId);
    // Shared daily cv_review budget for a real upload. Generated PDFs enforce this in their branch
    // only on a cache miss; this check stays before storage/row writes so a reject leaves no orphan.
    await this.analysisQuota.assertWithinDailyLimit(userId);

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
          contentHash,
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
      await this.analysisQuota.recordSuccessfulAnalysis(userId, cv.id);

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
    return { cv, file: await this.storage.download(cv.fileUrl) };
  }

  async remove(userId: string, cvId: string): Promise<void> {
    const cv = await this.findOwnedCv(userId, cvId);
    if (cv.fileUrl) await this.storage.delete(cv.fileUrl).catch(() => undefined);
    await this.cvs.softDelete({ id: cvId, userId });
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

    await this.entitlements.assertCanUse(userId, BillingFeatureKey.CV_BUILDER_CREATE);

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
        targetRole: this.normalizeTargetRole(dto.targetRole ?? source?.targetRole ?? undefined),
        isOcrOnly: false,
      }),
    );

    await this.entitlements.recordUsage(userId, BillingFeatureKey.CV_BUILDER_CREATE, {
      sourceType: 'cv',
      sourceId: cv.id,
    });
    return this.toResponse(cv, [], null);
  }

  async updateBuilderDraft(
    userId: string,
    cvId: string,
    dto: UpdateBuilderCvDto,
  ): Promise<CvResponseDto> {
    const cv = await this.findOwnedCv(userId, cvId);
    this.assertBuiltCv(cv);

    cv.parsedJson = this.cloneDocument(dto.parsedJson);
    cv.language = dto.language ?? dto.parsedJson.language ?? cv.language;
    if (dto.title !== undefined) cv.title = dto.title.trim() || cv.title;
    if (dto.targetRole !== undefined) cv.targetRole = this.normalizeTargetRole(dto.targetRole);

    const saved = await this.cvs.save(cv);
    return this.toResponse(saved, await this.getPersistedSkills(saved.id), null);
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
    await this.entitlements.assertCanUse(userId, BillingFeatureKey.CV_BUILDER_REWRITE);

    // PR4.5: mode='tailor' must NOT trust FE-sent skill/level. Reload the match + gap report,
    // verify ownership + the action, and let the rewriter build the instruction from the VERIFIED
    // action only. The verifier runs AFTER the quota gate above but the LLM call is inside
    // rewriter.rewrite — a verification reject here costs no LLM and no recorded usage (below).
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
    const response = verifiedAction
      ? await this.rewriter.rewrite(dto, userId, verifiedAction)
      : await this.rewriter.rewrite(dto, userId);
    await this.entitlements.recordUsage(userId, BillingFeatureKey.CV_BUILDER_REWRITE, {
      sourceType: 'cv',
      sourceId: cvId,
    });
    return response;
  }

  /** Companion Turn-1: verify ownership, then deterministically detect gaps + ask (no LLM, no quota). */
  async assistantAnalyze(
    userId: string,
    cvId: string,
    dto: AssistantAnalyzeRequestDto,
  ): Promise<CvAssistantTurn | null> {
    await this.findOwnedCv(userId, cvId);
    return cvBuilderAssistantTurn1({
      page: 'cv_builder',
      section: dto.section,
      field_path: dto.field_path,
      current_value: dto.current_value,
      locale: dto.locale ?? 'en',
    });
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
    await this.entitlements.assertCanUse(userId, BillingFeatureKey.CV_BUILDER_REWRITE);
    const result = await this.storyExtraction.extract(dto.story, dto.language ?? 'vi', userId);
    // A non-degraded call that still grounds ZERO projects delivered no LLM value (e.g. cert-only
    // story) — must stay free, matching the "no LLM value = free" norm used by assistantRewrite/Extract.
    if (!result.degraded && result.projects.length > 0) {
      await this.entitlements.recordUsage(userId, BillingFeatureKey.CV_BUILDER_REWRITE, {
        sourceType: 'cv',
        sourceId: cvId,
      });
    }
    return result;
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
      overall_score: diff.overall_score,
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
      overall_score: diff.overall_score,
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
    if (grounded.needs_detail.length === 0 && grounded.facts.length > 0) {
      await this.entitlements.assertCanUse(userId, BillingFeatureKey.CV_BUILDER_REWRITE);
    }
    const result = await this.cvAssistant.rewrite(
      {
        before: dto.before,
        answers: dto.answers,
        target: dto.target,
        language,
        outputLang: dto.output_lang ?? language,
        kind: dto.kind ?? 'bullet',
      },
      userId,
    );
    if (result.ok) {
      await this.entitlements.recordUsage(userId, BillingFeatureKey.CV_BUILDER_REWRITE, {
        sourceType: 'cv',
        sourceId: cvId,
      });
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
    await this.entitlements.assertCanUse(userId, BillingFeatureKey.CV_BUILDER_REWRITE);
    const result = await this.cvIntake.extract(
      {
        section: dto.section,
        narrative: dto.narrative,
        locale,
        outputLang: dto.output_lang ?? locale,
      },
      userId,
    );
    if (!result.degraded) {
      await this.entitlements.recordUsage(userId, BillingFeatureKey.CV_BUILDER_REWRITE, {
        sourceType: 'cv',
        sourceId: cvId,
      });
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
    await this.entitlements.assertCanUse(userId, BillingFeatureKey.CV_BUILDER_RENDER_PDF);
    const rendered = await this.pdfRenderer.renderHarvardPdf(cv);
    await this.entitlements.recordUsage(userId, BillingFeatureKey.CV_BUILDER_RENDER_PDF, {
      sourceType: 'cv',
      sourceId: cv.id,
    });
    return rendered;
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

    await this.entitlements.assertCanUse(userId, BillingFeatureKey.INTERVIEW_SESSION);
    const response = await this.interviewPlan.generatePlan(userId, {
      review,
      target_role: targetRole,
      lang,
    });
    await this.entitlements.recordUsage(userId, BillingFeatureKey.INTERVIEW_SESSION, {
      sourceType: 'cv',
      sourceId: cvId,
    });
    return response;
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

  async rerunReview(userId: string, cvId: string, requestedRole?: string): Promise<CvResponseDto> {
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
    const cached = await this.getLatestMatchingReview(userId, cv.id, role);
    if (cached) {
      return this.toResponse(cv, await this.getPersistedSkills(cv.id), cached);
    }

    cv.parsedText = parsedText;
    if (role && role !== cv.targetRole) {
      cv.targetRole = role;
      await this.cvs.save(cv);
    }
    await this.analysisQuota.assertWithinDailyLimit(userId);
    const review = await this.reviewCv(userId, cv, role ?? undefined);
    await this.analysisQuota.recordSuccessfulAnalysis(userId, cv.id);
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
      prompt_template_code: CV_REVIEW_PROMPT_CODE,
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

  async getLatestReview(userId: string, cvId: string): Promise<CvReviewParsedResponse | null> {
    const rows = (await this.aiResults.manager.query(
      `
        SELECT ar.parsed_response
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
    )) as Array<{ parsed_response: CvReviewParsedResponse | null }>;

    return rows[0]?.parsed_response ?? null;
  }

  private async getLatestMatchingReview(
    userId: string,
    cvId: string,
    targetRole: string | null,
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
        SELECT ar.parsed_response
        FROM ai_results ar
        INNER JOIN ai_requests req ON req.id = ar.ai_request_id
        WHERE ar.user_id = $1
          AND ar.result_type = $2
          AND req.request_payload -> 'payload' ->> 'cv_id' = $3
          AND req.request_payload -> 'payload' ->> 'target_role' IS NOT DISTINCT FROM $4
          AND req.request_payload -> 'payload' ->> 'prompt_template_code' = $5
        ORDER BY ar.created_at DESC
        LIMIT 1
      `,
      [userId, BillingFeatureKey.CV_REVIEW, cvId, targetRole, CV_REVIEW_PROMPT_CODE],
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

  private async enforceUploadQuota(userId: string): Promise<void> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const count = await this.cvs.count({
      where: {
        userId,
        cvKind: 'UPLOADED',
        createdAt: MoreThanOrEqual(cutoff),
      },
      withDeleted: true,
    });
    if (count >= MAX_REAL_UPLOADS_PER_DAY) {
      throw new HttpException(
        {
          errorCode: ERROR_CODES.CV_UPLOAD_QUOTA_EXCEEDED,
          message: 'CV upload quota exceeded. You can upload up to 10 CVs per 24 hours.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
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

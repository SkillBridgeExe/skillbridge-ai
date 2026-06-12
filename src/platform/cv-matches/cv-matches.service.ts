import {
  BadRequestException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { BillingFeatureKey } from '../../common/constants/billing.constants';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { AiResultEntity } from '../../database/entities/ai-result.entity';
import { CvEntity } from '../../database/entities/cv.entity';
import { CvMatchEntity } from '../../database/entities/cv-match.entity';
import { CvMatchScoreEntity } from '../../database/entities/cv-match-score.entity';
import { JobDescriptionEntity } from '../../database/entities/job-description.entity';
import { CvJdMatchService } from '../../modules/cv-jd-match/cv-jd-match.service';
import { CvJdMatchParsedResponse } from '../../modules/cv-jd-match/dto/cv-jd-match-response.dto';
import {
  GapReportService,
  SkillBridgeGapReport,
} from '../../modules/gap-report/gap-report.service';
import { EntitlementsService } from '../billing/entitlements.service';
import { CvsService } from '../cvs/cvs.service';
import { CreateCvMatchDto } from './dto/create-cv-match.dto';
import { CvMatchListItemDto, CvMatchResponseDto } from './dto/cv-match-response.dto';
import { JdTextExtractorService } from './jd-text-extractor.service';

const MAX_JD_FILE_BYTES = 5 * 1024 * 1024;
const MAX_JD_TEXT_LENGTH = 60_000;

@Injectable()
export class CvMatchesService {
  constructor(
    @InjectRepository(CvEntity) private readonly cvs: Repository<CvEntity>,
    @InjectRepository(JobDescriptionEntity)
    private readonly jobDescriptions: Repository<JobDescriptionEntity>,
    @InjectRepository(CvMatchEntity) private readonly matches: Repository<CvMatchEntity>,
    @InjectRepository(CvMatchScoreEntity)
    private readonly scores: Repository<CvMatchScoreEntity>,
    @InjectRepository(AiResultEntity)
    private readonly aiResults: Repository<AiResultEntity>,
    private readonly extractor: JdTextExtractorService,
    private readonly matcher: CvJdMatchService,
    private readonly entitlements: EntitlementsService,
    private readonly gapReport?: GapReportService,
    private readonly platformCvs?: CvsService,
  ) {}

  async createMatch(
    userId: string,
    cvId: string,
    dto: CreateCvMatchDto,
    file?: Express.Multer.File,
  ): Promise<CvMatchResponseDto> {
    const cv = await this.findOwnedCv(userId, cvId);
    if (!cv.parsedText) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.CV_PARSE_FAILED,
        message: 'CV has no parsed text to match',
      });
    }

    const jdText = await this.resolveJdText(dto, file);
    await this.entitlements.assertCanUse(userId, BillingFeatureKey.CV_JD_MATCH);
    const targetRole = this.trimOrNull(dto.targetRole) ?? this.trimOrNull(cv.targetRole);
    const jd = await this.jobDescriptions.save(
      this.jobDescriptions.create({
        userId,
        title: this.trimOrNull(dto.title) ?? file?.originalname ?? null,
        rawText: jdText,
        parsedJson: null,
        sourceType: file ? 'UPLOADED' : 'PASTED',
        documentId: null,
      }),
    );

    const ai = await this.matcher.match(userId, {
      cv_id: cv.id,
      cv_text: cv.parsedText,
      jd_id: jd.id,
      jd_text: jdText,
      scoring_template_code: 'cv_jd_match_v1',
      target_role: targetRole ?? undefined,
    });
    const parsed = ai.parsed_response;
    const matchRatio = parsed.match_ratio;
    const requiredCoveragePct = parsed.required_coverage * 100;

    const match = await this.matches.save(
      this.matches.create({
        cvId: cv.id,
        targetType: 'JOB_DESCRIPTION',
        jobDescriptionId: jd.id,
        aiResultId: ai.ai_result_id,
        overallScore: this.score(parsed.overall_score),
        semanticScore: this.score(matchRatio),
        atsScore: null,
        llmScore: null,
        ruleEngineScore: this.score(requiredCoveragePct),
        strengths: parsed.matched_skills,
        weaknesses: [...parsed.partial_skills, ...parsed.missing_skills],
        suggestions: {
          missing_skills: parsed.missing_skills,
          partial_skills: parsed.partial_skills,
          bonus_skills: parsed.bonus_skills,
          scoring_breakdown: parsed.scoring_breakdown,
        },
      }),
    );

    await this.scores.save(this.buildScoreRows(match.id, parsed));
    await this.entitlements.recordUsage(userId, BillingFeatureKey.CV_JD_MATCH, {
      sourceType: 'cv_match',
      sourceId: match.id,
    });
    return this.toResponse(match, jd, parsed);
  }

  async listMatches(
    userId: string,
    cvId: string,
    options: { page: number; limit: number },
  ): Promise<{ items: CvMatchListItemDto[]; total: number; page: number; limit: number }> {
    await this.findOwnedCv(userId, cvId);
    const qb = this.matches
      .createQueryBuilder('match')
      .leftJoin(JobDescriptionEntity, 'jd', 'jd.id = match.job_description_id')
      .where('match.cv_id = :cvId', { cvId })
      .orderBy('match.created_at', 'DESC')
      .skip((options.page - 1) * options.limit)
      .take(options.limit)
      .select([
        'match.id AS id',
        'match.cv_id AS "cvId"',
        'match.job_description_id AS "jobDescriptionId"',
        'match.overall_score AS "overallScore"',
        'match.semantic_score AS "matchRatio"',
        'match.rule_engine_score AS "requiredCoveragePct"',
        'match.created_at AS "createdAt"',
        'jd.title AS "jobTitle"',
        'jd.source_type AS "sourceType"',
      ]);

    const [rows, total] = await Promise.all([
      qb.getRawMany<{
        id: string;
        cvId: string;
        jobDescriptionId: string | null;
        overallScore: string | null;
        matchRatio: string | null;
        requiredCoveragePct: string | null;
        createdAt: Date;
        jobTitle: string | null;
        sourceType: string | null;
      }>(),
      this.matches.count({ where: { cvId } }),
    ]);

    return {
      items: rows.map((row) => ({
        id: row.id,
        cvId: row.cvId,
        jobDescriptionId: row.jobDescriptionId,
        jobTitle: row.jobTitle,
        sourceType: row.sourceType,
        overallScore: this.numberOrNull(row.overallScore),
        matchRatio: this.numberOrNull(row.matchRatio),
        requiredCoverage: this.percentToRatio(row.requiredCoveragePct),
        createdAt: row.createdAt.toISOString(),
      })),
      total,
      page: options.page,
      limit: options.limit,
    };
  }

  async getMatch(userId: string, cvId: string, matchId: string): Promise<CvMatchResponseDto> {
    await this.findOwnedCv(userId, cvId);
    const match = await this.matches.findOne({ where: { id: matchId, cvId } });
    if (!match) throw new NotFoundException('CV match not found');
    const jd = match.jobDescriptionId
      ? await this.jobDescriptions.findOne({ where: { id: match.jobDescriptionId } })
      : null;
    return this.toResponse(match, jd, await this.resolveParsedResponse(match));
  }

  async getGapReport(
    userId: string,
    matchId: string,
    lang: 'vi' | 'en' = 'vi',
  ): Promise<SkillBridgeGapReport> {
    const match = await this.matches.findOne({ where: { id: matchId } });
    if (!match) throw new NotFoundException('CV match not found');
    await this.findOwnedCv(userId, match.cvId);
    const parsed = await this.resolveParsedResponse(match);
    if (!parsed) throw new NotFoundException('CV match not found');
    if (!this.gapReport || !this.platformCvs) {
      throw new Error('Gap report dependencies are not configured');
    }
    return this.gapReport.build({
      match: parsed,
      review: await this.platformCvs.getLatestReview(userId, match.cvId),
      lang,
    });
  }

  private async findOwnedCv(userId: string, cvId: string): Promise<CvEntity> {
    const cv = await this.cvs.findOne({ where: { id: cvId, userId, deletedAt: IsNull() } });
    if (!cv) throw new NotFoundException('CV not found');
    return cv;
  }

  private async resolveJdText(dto: CreateCvMatchDto, file?: Express.Multer.File): Promise<string> {
    const pasted = this.trimOrNull(dto.jdText);
    if (pasted && file) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.VALIDATION_ERROR,
        message: 'Provide either jdText or file, not both',
      });
    }
    if (!pasted && !file) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.VALIDATION_ERROR,
        message: 'Job description text or file is required',
      });
    }
    if (file && file.size > MAX_JD_FILE_BYTES) {
      throw new PayloadTooLargeException({
        errorCode: ERROR_CODES.FILE_TOO_LARGE,
        message: 'Job description file must be 5MB or smaller',
      });
    }

    const text = pasted ?? (file ? await this.extractor.extract(file) : '');
    if (text.length > MAX_JD_TEXT_LENGTH) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.VALIDATION_ERROR,
        message: 'Job description text is too long',
      });
    }
    return text;
  }

  private buildScoreRows(matchId: string, parsed: CvJdMatchParsedResponse): CvMatchScoreEntity[] {
    return [
      this.scoreRow(matchId, 'overall_score', parsed.overall_score, 1),
      this.scoreRow(matchId, 'match_ratio', parsed.match_ratio, null),
      this.scoreRow(matchId, 'required_coverage', parsed.required_coverage * 100, null),
    ];
  }

  private scoreRow(
    matchId: string,
    criteriaName: string,
    score: number,
    weight: number | null,
  ): CvMatchScoreEntity {
    return this.scores.create({
      matchId,
      criteriaName,
      score: this.score(score),
      weight: weight === null ? null : this.score(weight),
    });
  }

  private toResponse(
    match: CvMatchEntity,
    jd: JobDescriptionEntity | null,
    parsed: CvJdMatchParsedResponse | null,
  ): CvMatchResponseDto {
    return {
      id: match.id,
      cvId: match.cvId,
      jobDescriptionId: match.jobDescriptionId,
      aiResultId: match.aiResultId,
      overallScore: this.numberOrNull(match.overallScore),
      matchRatio: this.numberOrNull(match.semanticScore),
      requiredCoverage: this.percentToRatio(match.ruleEngineScore),
      parsedResponse: parsed,
      jobDescription: jd
        ? {
            id: jd.id,
            title: jd.title,
            sourceType: jd.sourceType,
            createdAt: jd.createdAt.toISOString(),
          }
        : null,
      createdAt: match.createdAt.toISOString(),
    };
  }

  /**
   * Read-path parsed response: prefer the FULL-FIDELITY ai_results.parsed_response (the
   * exact object the AI module produced — keeps target_role, rubric_band,
   * source_of_requirements, keyword_frequency...). The denormalized match columns are a
   * lossy projection; reconstruction from them is only a fallback for legacy rows
   * (pre-aiResultId) or a pruned ai_results table. Hardcoding target_role=null in that
   * fallback was the prod bug that made gap-report market position return NO_ROLE.
   */
  private async resolveParsedResponse(
    match: CvMatchEntity,
  ): Promise<CvJdMatchParsedResponse | null> {
    if (match.aiResultId) {
      const row = await this.aiResults.findOne({ where: { id: match.aiResultId } });
      const parsed = row?.parsedResponse;
      if (parsed && typeof parsed === 'object') {
        return parsed as CvJdMatchParsedResponse;
      }
    }
    return this.reconstructParsedResponse(match);
  }

  private reconstructParsedResponse(match: CvMatchEntity): CvJdMatchParsedResponse | null {
    if (!match.strengths && !match.weaknesses && !match.suggestions) return null;
    const suggestions = (match.suggestions ?? {}) as Partial<CvJdMatchParsedResponse> & {
      scoring_breakdown?: CvJdMatchParsedResponse['scoring_breakdown'];
    };
    const weaknesses = Array.isArray(match.weaknesses) ? match.weaknesses : [];
    return {
      overall_score: this.numberOrNull(match.overallScore) ?? 0,
      match_ratio: this.numberOrNull(match.semanticScore) ?? 0,
      required_coverage: this.percentToRatio(match.ruleEngineScore) ?? 0,
      matched_skills: Array.isArray(match.strengths)
        ? (match.strengths as CvJdMatchParsedResponse['matched_skills'])
        : [],
      partial_skills:
        suggestions.partial_skills ??
        (weaknesses.filter(
          (item) => 'cv_level' in objectLike(item),
        ) as CvJdMatchParsedResponse['partial_skills']),
      missing_skills:
        suggestions.missing_skills ??
        (weaknesses.filter(
          (item) => !('cv_level' in objectLike(item)),
        ) as CvJdMatchParsedResponse['missing_skills']),
      bonus_skills: suggestions.bonus_skills ?? [],
      unnormalized_cv_skills: [],
      unnormalized_jd_requirements: [],
      scoring_breakdown:
        suggestions.scoring_breakdown ??
        ({
          total_requirements: 0,
          matched_count: 0,
          partial_count: 0,
          missing_count: 0,
          weight_sum: 0,
          achieved_weight: 0,
          required_total: 0,
          required_met: 0,
          raw_weighted_score: 0,
          cap_applied: false,
        } satisfies CvJdMatchParsedResponse['scoring_breakdown']),
      source_of_requirements: 'jd_extraction',
      target_role: null,
    };
  }

  private trimOrNull(value: string | null | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  }

  private score(value: number): string {
    return value.toFixed(2);
  }

  private numberOrNull(value: string | number | null | undefined): number | null {
    return value === null || value === undefined ? null : Number(value);
  }

  private percentToRatio(value: string | number | null | undefined): number | null {
    const number = this.numberOrNull(value);
    return number === null ? null : number / 100;
  }
}

function objectLike(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

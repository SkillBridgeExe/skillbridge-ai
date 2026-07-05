import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { BillingFeatureKey } from '../../common/constants/billing.constants';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { AiRequestEntity } from '../../database/entities/ai-request.entity';
import { AiResultEntity } from '../../database/entities/ai-result.entity';
import { CvEntity } from '../../database/entities/cv.entity';
import { CvMatchEntity } from '../../database/entities/cv-match.entity';
import { CvMatchScoreEntity } from '../../database/entities/cv-match-score.entity';
import { ImpactCalibrationEntity } from '../../database/entities/impact-calibration.entity';
import { InterviewSessionEntity } from '../../database/entities/interview-session.entity';
import { JobDescriptionEntity } from '../../database/entities/job-description.entity';
import { LearningSessionProgressEntity } from '../../database/entities/learning-session-progress.entity';
import {
  LearningLanguagePref,
  UserLearningPreferenceEntity,
} from '../../database/entities/user-learning-preference.entity';
import { PatchedTailorAction } from '../../modules/cv-jd-match/cv-patch';
import { CvJdMatchService } from '../../modules/cv-jd-match/cv-jd-match.service';
import { CvJdMatchParsedResponse } from '../../modules/cv-jd-match/dto/cv-jd-match-response.dto';
import { CvReviewParsedResponse } from '../../modules/cv-review/dto/cv-review-response.dto';
import {
  GapReportService,
  SkillBridgeGapReport,
} from '../../modules/gap-report/gap-report.service';
import { ExpectedImpact } from '../../modules/gap-report/impact-simulator';
import { buildUnifiedPlan } from '../../modules/gap-report/unified-plan';
import {
  baselineReport,
  buildProgressReport,
  ProgressReport,
  TransitionKind,
} from '../../modules/gap-report/gap-progress';
import { RoadmapService } from '../../modules/roadmap/roadmap.service';
import { ComposedRoadmap } from '../../modules/roadmap/roadmap-composer';
import { RoadmapComposerService } from '../../modules/roadmap/roadmap-composer.service';
import {
  buildInterviewPlanFromGapItems,
  InterviewFocusArea,
} from '../../modules/interview/interview-planner';
import { buildNextSteps, NextStep } from '../../modules/gap-advisor/gap-advisor';
import { InterviewPlanService } from '../../modules/interview/interview-plan.service';
import { InterviewPlanResponseDto } from '../../modules/interview/dto/interview-plan.dto';
import { coerceInterviewGapItems } from '../../modules/interview/interview-gap';
import { GithubEvidenceService } from '../../modules/github-evidence/github-evidence.service';
import { EntitlementsService } from '../billing/entitlements.service';
import { masteredSkillCanonicals } from '../learning/mastered-skills';
import { CvsService } from '../cvs/cvs.service';
import { CreateCvMatchDto } from './dto/create-cv-match.dto';
import { CvMatchListItemDto, CvMatchResponseDto } from './dto/cv-match-response.dto';
import { RoadmapFromMatchDto } from './dto/roadmap-from-match.dto';
import { InterviewPlanFromMatchDto } from './dto/interview-plan-from-match.dto';
import { JdTextExtractorService } from './jd-text-extractor.service';
import { jdContentHash } from './jd-content-hash';

const MAX_JD_FILE_BYTES = 5 * 1024 * 1024;
const MAX_JD_TEXT_LENGTH = 60_000;

// ME2 (Wave MEASURE): idempotent via the table's UNIQUE(prior_match_id, current_match_id,
// canonical_name) — repeated getProgress calls for the same scan pair are no-ops after the first.
const INSERT_IMPACT_CALIBRATION_SQL = `
  INSERT INTO impact_calibrations
    (user_id, prior_match_id, current_match_id, jd_content_hash, canonical_name, action_type,
     predicted_score_min, predicted_score_max, predicted_severity_drop,
     actual_score_delta, actual_severity_delta, status_transition, attempted)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
  ON CONFLICT (prior_match_id, current_match_id, canonical_name) DO NOTHING
`;

export interface OtherMatchSummary {
  /** Real ids for FE deep-linking (M1) — NEVER forwarded into the LLM-facing facts, only into the
   *  wire response's cited_match after the platform maps a validated citation index back to this list. */
  match_id: string;
  cv_id: string;
  jd_title: string | null;
  overall_score: number | null;
  top_gaps: string[];
  created_at: string;
}

@Injectable()
export class CvMatchesService {
  private readonly logger = new Logger(CvMatchesService.name);

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
    // Optional for positional unit-test construction; Nest injects it in the app (ConfigModule is
    // global). Drives the cv-jd-match prompt version (v1|v2) server-side. No @Optional() needed.
    private readonly config?: ConfigService,
    // Optional for positional unit-test construction; Nest injects it via RoadmapModule. Used only
    // by generateRoadmapFromMatch (server-derived learning roadmap).
    private readonly roadmap?: RoadmapService,
    // Optional for positional unit-test construction; Nest injects it via InterviewModule. Used only
    // by generateInterviewPlanFromMatch (server-derived interview practice plan).
    private readonly interviewPlan?: InterviewPlanService,
    // Optional for positional unit-test construction; Nest injects it via RoadmapModule. Used by the
    // deterministic roadmap-from-match flow.
    private readonly roadmapComposer?: RoadmapComposerService,
    @Optional()
    @InjectRepository(UserLearningPreferenceEntity)
    private readonly learningPreferences?: Repository<UserLearningPreferenceEntity>,
    // I3 (Wave IMPACT): optional for positional unit-test construction; Nest injects it via
    // GithubEvidenceModule. Used ONLY by getGapReport's opt-in github corroboration pre-pass —
    // never by the sub-report callers (progress/roadmap/interview/next-steps).
    private readonly githubEvidence?: GithubEvidenceService,
    // ME2 (Wave MEASURE): optional for positional unit-test construction; Nest always provides both
    // via CvMatchesModule's forFeature. Used ONLY by getProgress's best-effort calibration piggyback
    // (writeImpactCalibrations) — every other flow is byte-identical without them.
    @InjectRepository(ImpactCalibrationEntity)
    private readonly impactCalibrations?: Repository<ImpactCalibrationEntity>,
    @InjectRepository(AiRequestEntity)
    private readonly aiRequests?: Repository<AiRequestEntity>,
    // V1 (Wave VALUE_CHAIN): optional for positional unit-test construction; Nest provides it via
    // CvMatchesModule's forFeature. Read directly (TailorVerifier precedent) instead of injecting
    // InterviewGapReportService — that service depends on CvMatchesService (getGapReport), so
    // injecting it back here would be a DI cycle AND a runtime recursion. Used ONLY by
    // getGapReport's interview-signal pre-pass (fetchInterviewSignals).
    @InjectRepository(InterviewSessionEntity)
    private readonly interviewSessions?: Repository<InterviewSessionEntity>,
    // V2 (Wave VALUE_CHAIN): optional for positional unit-test construction; Nest provides it via
    // CvMatchesModule's forFeature. READ-ONLY view over Khoa's learning_session_progress rows —
    // used ONLY by getProgress's mastered-learning pre-pass (fetchMasteredCanonicals).
    @InjectRepository(LearningSessionProgressEntity)
    private readonly learningProgress?: Repository<LearningSessionProgressEntity>,
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
    // Atomic charge-first reserve (race-free); refunded below if the match fails — including the
    // deterministic OFF-TOPIC reject inside matcher.match, so a rejected non-JD stays free (the
    // pending product decision on charging junk input is unchanged by this refactor).
    const usage = await this.entitlements.reserveUsage(userId, BillingFeatureKey.CV_JD_MATCH);
    try {
      const targetRole = this.trimOrNull(dto.targetRole) ?? this.trimOrNull(cv.targetRole);
      const jd = await this.jobDescriptions.save(
        this.jobDescriptions.create({
          userId,
          title: this.trimOrNull(dto.title) ?? file?.originalname ?? null,
          rawText: jdText,
          contentHash: jdContentHash(jdText),
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
        // Server-side prompt version (CV_JD_MATCH_TEMPLATE_CODE). Default v1 when unconfigured (unit
        // tests / unset env); prod sets it via the typed config. FE never sends this.
        scoring_template_code:
          this.config?.get<string>('cvJdMatch.templateCode') ?? 'cv_jd_match_v1',
        target_role: targetRole ?? undefined,
        target_band: dto.targetBand ?? undefined,
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
      await usage.confirm({ sourceType: 'cv_match', sourceId: match.id });
      return this.toResponse(match, jd, parsed);
    } catch (error) {
      await usage.refund();
      throw error;
    }
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

  /**
   * I3 (Wave IMPACT): `github` is additive + opt-in (query params on the ONE main gap-report route
   * only — see CvMatchReportsController.gapReport). Every internal caller of this method (next-steps,
   * interview-plan-from-match, interview-focus-areas) omits it, so they never fetch github and stay
   * byte-identical to before this change.
   */
  async getGapReport(
    userId: string,
    matchId: string,
    lang: 'vi' | 'en' = 'vi',
    github?: { username: string; consent: boolean },
  ): Promise<SkillBridgeGapReport> {
    const { match, parsed } = await this.loadOwnedMatchParsedResponse(userId, matchId);
    const corroborated = github
      ? await this.fetchGithubCorroboration(userId, match.cvId, github, lang)
      : undefined;
    // V1 (Wave VALUE_CHAIN): real interview outcomes raise interview_risk on this ONE canonical
    // report path (and whatever is built on top of it). getProgress/roadmap deliberately bypass
    // this — see the comment in getProgress.
    const interviewSignals = await this.fetchInterviewSignals(userId, matchId);
    return this.buildGapReportFromParsed(
      userId,
      match,
      parsed,
      lang,
      corroborated,
      interviewSignals,
    );
  }

  /**
   * Never-throw: any failure (invalid username, rate-limited, no review yet, unexpected error) just
   * degrades to "no corroboration" — the gap report still builds normally, it simply skips the
   * evidence_risk downgrade + github citation for this request.
   */
  private async fetchGithubCorroboration(
    userId: string,
    cvId: string,
    github: { username: string; consent: boolean },
    lang: 'vi' | 'en',
  ): Promise<Map<string, { ref: string }> | undefined> {
    if (!this.githubEvidence || !this.platformCvs) return undefined;
    try {
      const review = await this.platformCvs.getLatestReview(userId, cvId);
      const dto = await this.githubEvidence.build({
        username: github.username,
        consent: github.consent,
        review,
        lang,
      });
      if (!dto.available) return undefined;
      const map = new Map<string, { ref: string }>();
      for (const c of dto.corroborated) {
        map.set(c.skill_canonical, { ref: c.repos[0]?.name ?? c.skill_canonical });
      }
      return map;
    } catch (err) {
      this.logger.warn(
        `github corroboration fetch failed for gap-report (cv ${cvId}): ${String(err)}`,
      );
      return undefined;
    }
  }

  /**
   * V1 (Wave VALUE_CHAIN): canonical → worst REAL interview outcome for this match, from the latest
   * COMPLETED session's persisted gap_items (already anti-fabrication-grounded at finalize — see
   * InterviewsService.finalize → groundInterviewGaps). Only skill-anchored weaknesses count
   * (knowledge_gap/evidence_gap with a canonical); max severity wins per canonical.
   *
   * Never-throw: any failure just degrades to "no signals" — the gap report builds normally.
   * ponytail: sessions WITHOUT persisted gap_items (legacy, pre-persist finalize) are skipped rather
   * than re-derived from ai_results — re-deriving lives in InterviewGapReportService, which calls
   * getGapReport back (recursion). Revisit only if legacy sessions ever matter here.
   */
  private async fetchInterviewSignals(
    userId: string,
    matchId: string,
  ): Promise<Map<string, { risk: number; ref: string }> | undefined> {
    if (!this.interviewSessions) return undefined;
    try {
      const session = await this.interviewSessions.findOne({
        where: { userId, cvMatchId: matchId, status: 'COMPLETED', gapItems: Not(IsNull()) },
        order: { endedAt: 'DESC', createdAt: 'DESC' },
      });
      if (!session) return undefined;
      const ref = session.id.slice(0, 8);
      const map = new Map<string, { risk: number; ref: string }>();
      for (const item of coerceInterviewGapItems(session.gapItems)) {
        if (item.weakness_type !== 'knowledge_gap' && item.weakness_type !== 'evidence_gap') {
          continue;
        }
        if (!item.skill_canonical) continue;
        const prev = map.get(item.skill_canonical);
        if (!prev || item.severity > prev.risk) {
          map.set(item.skill_canonical, { risk: item.severity, ref });
        }
      }
      return map.size ? map : undefined;
    } catch (err) {
      this.logger.warn(
        `interview signal fetch failed for gap-report (match ${matchId}): ${String(err)}`,
      );
      return undefined;
    }
  }

  /**
   * V2 (Wave VALUE_CHAIN): skill canonicals whose SkillBridge lesson this user FULLY mastered
   * (Khoa's per-objective quiz predicate aggregated over every objective — see
   * masteredSkillCanonicals for the session→skill join and its trade-off). Surfaced as
   * pending-verification presentation data only (ProgressReport.learning_completed) — it NEVER
   * lowers evidence_risk or severity: finishing a course is not CV evidence until a re-scan proves it.
   *
   * Never-throw: any failure degrades to "no mastered learning" — progress builds normally.
   * ONE batched query (all of the user's rows) + in-memory aggregation, no per-skill N+1.
   */
  private async fetchMasteredCanonicals(userId: string): Promise<Set<string> | undefined> {
    if (!this.learningProgress) return undefined;
    try {
      const rows = await this.learningProgress.find({ where: { userId } });
      const mastered = masteredSkillCanonicals(rows);
      return mastered.size ? mastered : undefined;
    } catch (err) {
      this.logger.warn(
        `mastered-learning fetch failed for progress (user ${userId}): ${String(err)}`,
      );
      return undefined;
    }
  }

  async getReviewForMatch(userId: string, matchId: string): Promise<CvReviewParsedResponse | null> {
    const match = await this.matches.findOne({ where: { id: matchId } });
    if (!match) throw new NotFoundException('CV match not found');
    await this.findOwnedCv(userId, match.cvId);
    if (!this.platformCvs) {
      throw new Error('CV review dependency is not configured');
    }
    return this.platformCvs.getLatestReview(userId, match.cvId);
  }

  async getProgress(userId: string, matchId: string): Promise<ProgressReport> {
    const { match: current, parsed: currParsed } = await this.loadOwnedMatchParsedResponse(
      userId,
      matchId,
    );
    // V1 (Wave VALUE_CHAIN): this path deliberately does NOT fetch interview signals (neither for
    // prior nor current): the ME2 calibration piggyback below compares prior-vs-current severity,
    // and injecting a real-interview raise into only the current side would contaminate
    // actual_severity_delta with a non-CV signal. Progress gets interview signals in a later wave,
    // once calibration has a clean baseline.
    const currReport = await this.buildGapReportFromParsed(userId, current, currParsed);
    const currGaps = currReport.gap_items;
    const currScore = this.numberOrNull(current.overallScore);
    // V2 (Wave VALUE_CHAIN): mastered learning is PRESENTATION data (learning_completed, pending
    // verification) — unlike interview signals above, it never touches severity, so it cannot
    // contaminate the ME2 calibration and is safe on every exit path, baseline included.
    const mastered = await this.fetchMasteredCanonicals(userId);

    if (!current.jobDescriptionId) return baselineReport(currGaps, currScore, mastered);

    const currentJd = await this.jobDescriptions.findOne({
      where: { id: current.jobDescriptionId },
    });
    if (!currentJd?.contentHash) return baselineReport(currGaps, currScore, mastered);

    // Lineage = same USER + same JD CONTENT (hash), any cvId: an edited re-uploaded CV gets a
    // new cv row, and every match saves a new jd row — the old (cvId, jobDescriptionId) key
    // never matched a real re-scan, so progress was always "baseline".
    const prior = await this.matches
      .createQueryBuilder('m')
      .innerJoin(JobDescriptionEntity, 'jd', 'jd.id = m.jobDescriptionId')
      .innerJoin(CvEntity, 'cv', 'cv.id = m.cvId')
      .where('cv.userId = :userId', { userId })
      .andWhere('jd.contentHash = :hash', { hash: currentJd.contentHash })
      .andWhere('m.createdAt < :createdAt', { createdAt: current.createdAt })
      .orderBy('m.createdAt', 'DESC')
      .getOne();
    if (!prior) return baselineReport(currGaps, currScore, mastered);

    // Prior was found via a query already scoped to cv.userId = :userId, so ownership is
    // established — read its parsed response directly rather than re-checking via
    // loadOwnedMatchParsedResponse (which is scoped to the CALLER's cvId, not prior's).
    const prevParsed = await this.resolveParsedResponse(prior);
    if (!prevParsed) return baselineReport(currGaps, currScore, mastered);

    try {
      const prevReport = await this.buildGapReportFromParsed(userId, prior, prevParsed);
      // No template code is stored on the match row — infer it from schema shape instead:
      // only the v2 (jd_intelligence) prompt template ever emits jd_dimensions.
      const isV2 = (p: CvJdMatchParsedResponse) => p.jd_dimensions !== undefined;
      const templateChanged = isV2(prevParsed) !== isV2(currParsed);
      const progress = buildProgressReport(prevReport.gap_items, currGaps, {
        prevScore: this.numberOrNull(prior.overallScore),
        currScore,
        prevCoverage: prevParsed.required_coverage ?? null,
        currCoverage: currParsed.required_coverage ?? null,
        prevJdIntel: prevReport.jd_intelligence?.dimensions ?? null,
        currJdIntel: currReport.jd_intelligence?.dimensions ?? null,
        templateChanged,
        masteredCanonicals: mastered,
      });
      // ME2 (Wave MEASURE): best-effort calibration piggyback — reuses prevReport (scan-N's
      // recommended_actions + expected_impact) and progress (scan-N vs N+1 transitions) that this
      // call already built; never re-derives, never throws (see writeImpactCalibrations).
      await this.writeImpactCalibrations({
        userId,
        prior,
        current,
        jdContentHash: currentJd.contentHash,
        prevReport,
        progress,
        templateChanged,
      });
      return progress;
    } catch {
      // Prior gap-report unavailable (e.g. legacy/empty ai_results): degrade to a
      // baseline reading rather than fabricate a diff. We intentionally do NOT surface
      // prior.overallScore here — without the prior gaps there is no honest comparison,
      // so the FE shows "first measurement" instead of a misleading partial delta.
      return baselineReport(currGaps, currScore, mastered);
    }
  }

  /**
   * Generate a deterministic learning roadmap from server-derived GapItems.
   * UnifiedDevelopmentPlan selects learn items; RoadmapComposerService handles feasibility and resources.
   */
  async generateRoadmapFromMatch(
    userId: string,
    matchId: string,
    dto: RoadmapFromMatchDto,
  ): Promise<ComposedRoadmap> {
    const { match, parsed } = await this.loadOwnedMatchParsedResponse(userId, matchId);
    // Atomic charge-first reserve (race-free); refunded on any failure below.
    const usage = await this.entitlements.reserveUsage(userId, BillingFeatureKey.ROADMAP_GENERATE, {
      sourceType: 'cv_match',
      sourceId: matchId,
    });
    try {
      const report = await this.buildGapReportFromParsed(userId, match, parsed);
      const plan = buildUnifiedPlan({
        matchId,
        sessionId: null,
        gapItems: report.gap_items,
        interviewItems: [],
        actions: report.recommended_actions,
      });
      const preferences = await this.learningPreferences?.findOne({ where: { userId } });
      const budget = {
        available_days: dto.available_days ?? preferences?.availableDays ?? 30,
        hours_per_week: dto.hours_per_week ?? preferences?.hoursPerWeek ?? 8,
      };
      const languagePref: LearningLanguagePref =
        dto.language_pref ?? preferences?.languagePref ?? 'both';

      if (plan.learn_items.length === 0) {
        return {
          budget_hours: Number(((budget.available_days * budget.hours_per_week) / 7).toFixed(1)),
          steps: [],
          not_feasible_items: [],
          ai_summary:
            'No learnable skill gaps were found for this match; remaining gaps should be handled through CV evidence, wording, or interview practice.',
          no_learning_gaps: true,
        };
      }

      if (!this.roadmapComposer) {
        throw new Error('Roadmap composer dependency is not configured');
      }

      return await this.roadmapComposer.compose({
        learnItems: plan.learn_items,
        gapItems: report.gap_items,
        budget,
        languagePref,
      });
    } catch (error) {
      await usage.refund();
      throw error;
    }
  }

  /**
   * Generate a gap-targeted interview practice plan from the match's GapReport. The probe topics are
   * derived SERVER-SIDE from the canonical gap_items (skill-type only, evidence-priority, deduped) —
   * the client supplies no skills. Reuses getGapReport for load + ownership; delegates phrasing to the
   * unchanged AI-lane InterviewPlanService (deterministic plan, LLM only words it). When there are no
   * skill-type gaps to probe, returns an honest empty-state with no LLM call.
   */
  async generateInterviewPlanFromMatch(
    userId: string,
    matchId: string,
    dto: InterviewPlanFromMatchDto,
  ): Promise<InterviewPlanResponseDto> {
    const lang = dto.lang ?? 'vi';
    const report = await this.getGapReport(userId, matchId, lang);
    const focusAreas = buildInterviewPlanFromGapItems(report.gap_items, lang);

    if (focusAreas.length === 0) {
      return {
        ai_request_id: '',
        target_role: report.target_role ?? '',
        language: lang,
        items: [],
        llm_enhanced: false,
        token_usage: 0,
        no_focus_areas: true,
      };
    }

    if (!this.interviewPlan) {
      throw new Error('Interview plan dependency is not configured');
    }
    return this.interviewPlan.phrasePlan(userId, focusAreas, report.target_role ?? '', lang);
  }

  /**
   * gap_next_step_advisor: prioritized, grounded next steps for a match, derived SERVER-SIDE from the
   * canonical gap_items (severity-ranked, REAL gaps only). Reuses getGapReport for load + ownership.
   * Deterministic — no LLM, can never invent a gap.
   */
  async getNextSteps(
    userId: string,
    matchId: string,
    lang: 'vi' | 'en' = 'vi',
  ): Promise<{
    match_id: string;
    target_role: string | null;
    language: 'vi' | 'en';
    steps: NextStep[];
  }> {
    const report = await this.getGapReport(userId, matchId, lang);
    return {
      match_id: matchId,
      target_role: report.target_role ?? null,
      language: lang,
      steps: buildNextSteps(report.gap_items, lang),
    };
  }

  /**
   * Deterministic gap-targeted interview focus areas for a match — the SAME canonical, evidence-priority,
   * severity-ranked focus areas the prep-plan uses (buildInterviewPlanFromGapItems), so the LIVE interview
   * probes the same gaps. Reuses getGapReport for load + ownership. Returns [] when there are no skill gaps.
   */
  async getInterviewFocusAreas(
    userId: string,
    matchId: string,
    lang: 'vi' | 'en' = 'vi',
  ): Promise<InterviewFocusArea[]> {
    const report = await this.getGapReport(userId, matchId, lang);
    return buildInterviewPlanFromGapItems(report.gap_items, lang);
  }

  async listRecentMatchSummariesForUser(
    userId: string,
    excludeMatchId: string,
    limit = 3,
  ): Promise<OtherMatchSummary[]> {
    const rows = await this.matches
      .createQueryBuilder('m')
      .innerJoin(CvEntity, 'cv', 'cv.id = m.cvId')
      .leftJoin(JobDescriptionEntity, 'jd', 'jd.id = m.jobDescriptionId')
      .where('cv.userId = :userId', { userId })
      .andWhere('cv.deletedAt IS NULL')
      .andWhere('m.id != :excludeMatchId', { excludeMatchId })
      .orderBy('m.createdAt', 'DESC')
      .take(limit)
      .select([
        'm.id AS "matchId"',
        'cv.id AS "cvId"',
        'jd.title AS "jdTitle"',
        'm.overallScore AS "overallScore"',
        'm.suggestions AS "suggestions"',
        'm.createdAt AS "createdAt"',
      ])
      .getRawMany<{
        matchId: string;
        cvId: string;
        jdTitle: string | null;
        overallScore: string | number | null;
        suggestions: unknown;
        createdAt: Date | string;
      }>();

    return rows.map((row) => ({
      match_id: row.matchId,
      cv_id: row.cvId,
      jd_title: row.jdTitle,
      overall_score: this.numberOrNull(row.overallScore),
      top_gaps: this.topPersistedGaps(row.suggestions),
      created_at:
        row.createdAt instanceof Date
          ? row.createdAt.toISOString()
          : new Date(row.createdAt).toISOString(),
    }));
  }

  private async loadOwnedMatchParsedResponse(
    userId: string,
    matchId: string,
  ): Promise<{ match: CvMatchEntity; parsed: CvJdMatchParsedResponse }> {
    const match = await this.matches.findOne({ where: { id: matchId } });
    if (!match) throw new NotFoundException('CV match not found');
    await this.findOwnedCv(userId, match.cvId);
    const parsed = await this.resolveParsedResponse(match);
    if (!parsed) throw new NotFoundException('CV match not found');
    return { match, parsed };
  }

  private async buildGapReportFromParsed(
    userId: string,
    match: CvMatchEntity,
    parsed: CvJdMatchParsedResponse,
    lang: 'vi' | 'en' = 'vi',
    corroborated?: Map<string, { ref: string }>,
    interviewSignals?: Map<string, { risk: number; ref: string }>,
  ): Promise<SkillBridgeGapReport> {
    if (!this.gapReport || !this.platformCvs) {
      throw new Error('Gap report dependencies are not configured');
    }
    return this.gapReport.build({
      match: parsed,
      review: await this.platformCvs.getLatestReview(userId, match.cvId),
      lang,
      corroborated,
      interviewSignals,
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

  /**
   * ME2 (Wave MEASURE): best-effort calibration write, piggybacked on a successful getProgress
   * build with a REAL prior. NEVER throws — any failure (lossy prior, template drift, DB error)
   * degrades to a logger.warn; the progress response the caller already computed is unaffected.
   */
  private async writeImpactCalibrations(input: {
    userId: string;
    prior: CvMatchEntity;
    current: CvMatchEntity;
    jdContentHash: string;
    prevReport: SkillBridgeGapReport;
    progress: ProgressReport;
    templateChanged: boolean;
  }): Promise<void> {
    if (!this.impactCalibrations || !this.aiRequests) return;
    try {
      if (input.templateChanged) {
        this.logger.warn(
          `impact calibration skipped for match ${input.current.id}: scoring template changed between scans`,
        );
        return;
      }
      if (await this.isLossyParsedResponse(input.prior)) {
        this.logger.warn(
          `impact calibration skipped for match ${input.current.id}: prior parsed_response was reconstructed (lossy) — gap_items not comparable`,
        );
        return;
      }

      const actions = input.prevReport.recommended_actions.filter(
        (a): a is PatchedTailorAction & { expected_impact: ExpectedImpact } =>
          a.expected_impact !== undefined,
      );
      if (actions.length === 0) return;

      // Attribution-noise policy (approved): the whole-match score delta is copied onto every
      // action row from this scan pair — we cannot isolate which action moved the score, only
      // that these actions were the ones recommended when the score was priorScore.
      const priorScore = this.numberOrNull(input.prior.overallScore);
      const currScore = this.numberOrNull(input.current.overallScore);
      const actualScoreDelta =
        priorScore === null || currScore === null ? null : this.roundTo(currScore - priorScore, 2);

      const transitionByCanonical = new Map(
        input.progress.transitions.map((t) => [t.canonical_name, t] as const),
      );
      const closedSet = new Set(input.progress.gaps_closed);
      const attempted = await this.attemptedActionIds(
        input.userId,
        input.prior.createdAt,
        input.current.createdAt,
        input.prior.id,
        actions.map((a) => a.action_id),
      );

      for (const action of actions) {
        const transition = transitionByCanonical.get(action.skill_canonical);
        let statusTransition: TransitionKind | null = null;
        let actualSeverityDelta: number | null = null;
        if (transition) {
          statusTransition = transition.kind;
          actualSeverityDelta =
            transition.prev_severity === null
              ? null
              : this.roundTo(transition.curr_severity - transition.prev_severity, 3);
        } else if (closedSet.has(action.skill_canonical)) {
          // Gap-progress semantics: the canonical dropped out of curr's gap_items entirely (no
          // transition entry emitted for it) but WAS in prevOpen — i.e. gone + was-fixable, the
          // same definition diffGapProgress uses for gaps_closed. No curr severity to diff.
          statusTransition = 'closed';
        }
        // Neither map has this canonical: never fabricate a transition — skip this action's row.
        if (!statusTransition) continue;

        await this.impactCalibrations.manager.query(INSERT_IMPACT_CALIBRATION_SQL, [
          input.userId,
          input.prior.id,
          input.current.id,
          input.jdContentHash,
          action.skill_canonical,
          action.action_type,
          action.expected_impact.score_min,
          action.expected_impact.score_max,
          action.expected_impact.severity_drop,
          actualScoreDelta,
          actualSeverityDelta,
          statusTransition,
          attempted.has(action.action_id),
        ]);
      }
    } catch (err) {
      this.logger.warn(
        `impact calibration write failed for match ${input.current.id}: ${String(err)}`,
      );
    }
  }

  /**
   * Whether resolveParsedResponse's read for this match fell back to the LOSSY
   * reconstructParsedResponse path (:691) rather than the full-fidelity ai_results row. Re-reads
   * aiResults by id rather than widening resolveParsedResponse's return contract — that method has
   * two other call sites (getMatch, loadOwnedMatchParsedResponse) that only ever want the parsed
   * value. ponytail: one extra findOne by pk; getProgress is not a hot path.
   */
  private async isLossyParsedResponse(match: CvMatchEntity): Promise<boolean> {
    if (!match.aiResultId) return true;
    const row = await this.aiResults.findOne({ where: { id: match.aiResultId } });
    return !(row?.parsedResponse && typeof row.parsedResponse === 'object');
  }

  /**
   * ME1 join: which of these action_ids have a cv_rewrite tailor trace between the two scans.
   * ONE query (batched by actionIds, no N+1). requestPayload is jsonb; ->> is a plain text
   * projection. Match id is required because action_id is only canonical/action-type stable
   * (e.g. "missing_required:react"), not globally unique across the user's matches. No composite
   * (user_id, request_type, created_at) index exists yet — relies on the individual indexes on each
   * column (ai-request.entity.ts) to bound the scan; acceptable given per-user cv_rewrite volume
   * between two scans is small. Revisit with a composite index if this ever shows up in a slow-query
   * report.
   */
  private async attemptedActionIds(
    userId: string,
    from: Date,
    to: Date,
    matchId: string,
    actionIds: string[],
  ): Promise<Set<string>> {
    if (!this.aiRequests || actionIds.length === 0) return new Set();
    const rows = await this.aiRequests.manager.query<Array<{ action_id: string }>>(
      `SELECT DISTINCT request_payload -> 'payload' ->> 'action_id' AS action_id
         FROM ai_requests
        WHERE user_id = $1
          AND request_type = 'cv_rewrite'
          AND created_at BETWEEN $2 AND $3
          AND request_payload -> 'payload' ->> 'match_id' = $4
          AND request_payload -> 'payload' ->> 'action_id' = ANY($5::text[])`,
      [userId, from, to, matchId, actionIds],
    );
    return new Set(rows.map((r) => r.action_id));
  }

  private roundTo(value: number, decimals: number): number {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
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

  private topPersistedGaps(suggestions: unknown): string[] {
    const persisted = objectLike(suggestions);
    return [
      ...this.displayNamesFromPersistedGaps(persisted.missing_skills),
      ...this.displayNamesFromPersistedGaps(persisted.partial_skills),
    ].slice(0, 2);
  }

  private displayNamesFromPersistedGaps(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
      .map((item) => objectLike(item).display_name)
      .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);
  }
}

function objectLike(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

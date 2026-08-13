import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, LessThan, Not, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { BillingFeatureKey } from '../../common/constants/billing.constants';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { maskPii } from '../../common/services/pii-mask';
import { deriveCvSeniority } from '../../common/services/seniority';
import { SkillTextScannerService } from '../../common/services/skill-text-scanner.service';
import { CanonicalCvDocument } from '../../common/types/canonical-cv';
import { CvEntity } from '../../database/entities/cv.entity';
import { CvMatchEntity } from '../../database/entities/cv-match.entity';
import {
  DEFAULT_INTERVIEW_SPEECH_SPEED,
  InterviewType,
  InterviewSessionEntity,
} from '../../database/entities/interview-session.entity';
import { InterviewTurnEntity } from '../../database/entities/interview-turn.entity';
import { InterviewQuestionBankItemEntity } from '../../database/entities/interview-question-bank-item.entity';
import {
  buildInterviewQuestionBankSeeds,
  QUESTION_BANK_TARGET_ROLES,
} from '../../database/interview-question-bank-seeds';
import { JobDescriptionEntity } from '../../database/entities/job-description.entity';
import { InterviewService as InterviewAiService } from '../../modules/interview/interview.service';
import { PromptsService } from '../../modules/prompts/prompts.service';
import { InterviewFocusArea } from '../../modules/interview/interview-planner';
import {
  AgendaTopic,
  buildInterviewAgenda,
  DepthSignal,
  groundInterviewThread,
  InterviewAgenda,
  InterviewPhase as AgendaInterviewPhase,
  InterviewState,
  InterviewTurnTrace,
  TURN_BUDGET_BY_TIER,
} from '../../modules/interview/interview-agenda';
import {
  InterviewQuestionBankCandidate,
  normalizeQuestionBankTargetRole,
  selectInterviewQuestion,
} from '../../modules/interview/interview-question-bank';
import {
  analyzeAnswerSignals,
  AnswerSignals,
  Language,
} from '../../modules/interview/answer-analyzer';
import { AnswerInsight } from '../../modules/interview/answer-insight';
import { AnswerInsightService } from '../../modules/interview/answer-insight.service';
import {
  calibrateInterviewAnswerScores,
  CalibratedAnswerScores,
  CalibratedAnswerScore,
  explainInterviewScore,
  reconcileDepthSignal,
  Dimension,
  InterviewScore,
  topicDimensions,
} from '../../modules/interview/interview-scoring';
import {
  AnswerGapContext,
  deriveInterviewGaps,
} from '../../modules/interview/interview-gap-derive';
import {
  buildInterviewOpening,
  InterviewIdentity,
  resolveInterviewIdentity,
} from '../../modules/interview/interview-context';
import { groundInterviewGaps } from '../../modules/interview/interview-gap';
import { buildUnifiedPlan, UnifiedDevelopmentPlan } from '../../modules/gap-report/unified-plan';
import { GapItem } from '../../modules/gap-engine/gap-item';
import { InterviewCoaching } from '../../modules/interview/interview-coaching';
import { InterviewCoachingService } from '../../modules/interview/interview-coaching.service';
import { classifySeniority, SeniorityLevel } from '../../modules/jobs/ingest/ingest-normalizers';
import { EntitlementsService } from '../billing/entitlements.service';
import { CreditAwareUsageService } from '../billing/credit-aware-usage.service';
import { CvMatchesService } from '../cv-matches/cv-matches.service';
import {
  EndPlatformInterviewDto,
  InterviewContextMode,
  InterviewDetailResponseDto,
  InterviewAnalysisStatus,
  InterviewListQueryDto,
  InterviewSessionDto,
  InterviewTurnDto,
  RealtimeClientSecretDto,
  StartInterviewResponseDto,
  StartPlatformInterviewDto,
} from './dto/interview.dto';
import {
  DEFAULT_REALTIME_TRANSCRIPTION_MODEL,
  INTERVIEW_REALTIME_PROTOCOL_VERSION,
  OpenAiRealtimeTokenService,
} from './openai-realtime-token.service';
import { InterviewChainLlmService } from './interview-chain-llm.service';
import { applyScoreCap, collapseQuestionThreads } from './interview-thread-scoring';
import { resolveInterviewVoice } from './interview-voice';

interface InterviewFinalizationState {
  status: 'PENDING' | 'READY' | 'FAILED';
  attemptId: string;
  startedAt: string;
  completedAt?: string;
  failedAt?: string;
}

const PRO_INTERVIEW_SECONDS = 10 * 60;
const PREMIUM_INTERVIEW_SECONDS = 15 * 60;
const CJK_SCRIPT_PATTERN = /[\u3400-\u9FFF\uF900-\uFAFF]/u;

/**
 * I-PACE: seconds a real interviewer gives for one answer. A fresh question earns the full
 * budget; a follow-up drills a point already made, so it earns less.
 *
 * This lives HERE and not in `interview-agenda.ts` on purpose: the agenda is deliberately
 * time-blind (`decide()` reads turn counts only) and every time rule in this product already
 * lives in this service. Keep that split.
 *
 * These are COACHING budgets, not cutoffs. The engine never shortens, skips or penalises an
 * answer for exceeding one \u2014 the client nudges at the budget and only force-submits at a
 * generous ceiling, so a candidate who needs longer is never cut off mid-thought. See the
 * benchmark spec \u00A73: we adopt the screener's question intelligence, not its harshness.
 */
const MAIN_ANSWER_BUDGET_SECONDS = 90;
const FOLLOW_UP_ANSWER_BUDGET_SECONDS = 60;

export const answerTimeBudgetSeconds = (kind: InterviewNextQuestionKind): number | null =>
  kind === null
    ? null
    : kind === 'opening' || kind === 'transition'
      ? MAIN_ANSWER_BUDGET_SECONDS
      : FOLLOW_UP_ANSWER_BUDGET_SECONDS;

const LEGACY_TRANSCRIPTION_PROMPT_PATTERNS = [
  /Cuộc phỏng vấn bằng tiếng Việt/i,
  /Giữ nguyên dấu tiếng Việt/i,
  /English interview\. Preserve technical terms/i,
];
const CONTEXT_SPECIFIC_QUESTION_PATTERN =
  /\b(?:CV|resume|job description|JD|gap|matched strengths|weaknesses|tailoring suggestions)\b/i;
let cachedQuestionBankSeedItems: InterviewQuestionBankCandidate[] | null = null;

/**
 * Render the canonical gap focus areas (severity-ranked, evidence-priority — the SAME ones the prep-plan
 * uses) into a prompt block so the LIVE interviewer probes those gaps first. Returns '' when there are none
 * (caller then falls back to the raw match weaknesses).
 */
export function formatGapFocusForPrompt(focusAreas: InterviewFocusArea[]): string {
  if (!focusAreas.length) return '';
  const lines = focusAreas.map(
    (f, i) => `${i + 1}. [${f.focus_type}] ${f.display_name} — ${f.reason}`,
  );
  return `Priority focus areas (canonical skill gaps — probe these first, in this order):\n${lines.join('\n')}`;
}

interface InterviewContextSnapshot {
  contextMode: InterviewContextMode;
  identity?: InterviewIdentity;
  /** Masked, bounded CV/JD grounding kept for subsequent turns and realtime reconnects. */
  interviewContext?: string;
  cv: { id: string; title: string | null; targetRole: string | null } | null;
  jobDescription: { id: string; title: string | null; sourceType: string | null } | null;
  cvMatch: {
    id: string;
    overallScore: unknown;
    strengths: unknown;
    weaknesses: unknown;
    suggestions: unknown;
  } | null;
  targetRole: string;
  interviewDifficulty: InterviewDifficultyProfile;
}

interface InterviewContext {
  contextMode: InterviewContextMode;
  identity: InterviewIdentity;
  cv: CvEntity | null;
  match: CvMatchEntity | null;
  jd: JobDescriptionEntity | null;
  focusAreas: InterviewFocusArea[];
  targetRole: string;
  snapshot: InterviewContextSnapshot;
  promptContext: string;
}

interface FinalizedTurnAnalysis {
  turn: InterviewTurnEntity;
  topicPhase: AgendaInterviewPhase;
  skillCanonical: string | null;
  displayName: string;
  score: number | null;
  depthSignal: DepthSignal | null;
  signals: AnswerSignals;
  insight: AnswerInsight;
  scoreAssessments: CalibratedAnswerScores;
  scoreAssessment: CalibratedAnswerScore | null;
}

function averageCalibratedScores(scores: CalibratedAnswerScores): number | null {
  const values = Object.values(scores)
    .map((assessment) => assessment.score)
    .filter((score): score is number => typeof score === 'number' && Number.isFinite(score));
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, score) => sum + score, 0) / values.length);
}

type InterviewDifficultyLevel = 'intern' | 'fresher' | 'junior' | 'mid' | 'senior' | 'lead';
type InterviewDifficultySource = 'target role' | 'job description' | 'candidate CV' | 'default';
type InterviewNextQuestionKind = 'opening' | 'follow_up' | 'transition' | 'closing' | null;

interface InterviewDifficultyProfile {
  level: InterviewDifficultyLevel;
  source: InterviewDifficultySource;
  note: string;
}

@Injectable()
export class InterviewsService {
  private readonly logger = new Logger(InterviewsService.name);
  private readonly activeFinalizations = new Map<string, InterviewFinalizationState>();

  constructor(
    @InjectRepository(InterviewSessionEntity)
    private readonly sessions: Repository<InterviewSessionEntity>,
    @InjectRepository(InterviewTurnEntity)
    private readonly turns: Repository<InterviewTurnEntity>,
    @InjectRepository(CvEntity)
    private readonly cvs: Repository<CvEntity>,
    @InjectRepository(CvMatchEntity)
    private readonly matches: Repository<CvMatchEntity>,
    @InjectRepository(JobDescriptionEntity)
    private readonly jobDescriptions: Repository<JobDescriptionEntity>,
    private readonly interviewAi: InterviewAiService,
    private readonly entitlements: EntitlementsService,
    private readonly realtime: OpenAiRealtimeTokenService,
    // Optional positionally (keeps existing unit-test constructions valid) but always DI-provided in
    // prod via CvMatchesModule — used to inject the canonical gap focus areas into the live interview.
    private readonly cvMatches?: CvMatchesService,
    private readonly interviewChain?: InterviewChainLlmService,
    private readonly answerInsight?: AnswerInsightService,
    private readonly coachingService?: InterviewCoachingService,
    @Optional()
    @InjectRepository(InterviewQuestionBankItemEntity)
    private readonly questionBankItems?: Repository<InterviewQuestionBankItemEntity>,
    @Optional()
    private readonly config?: ConfigService,
    @Optional()
    private readonly prompts?: PromptsService,
    @Optional()
    private readonly creditAwareUsage?: CreditAwareUsageService,
    @Optional()
    private readonly skillScanner?: SkillTextScannerService,
  ) {}

  async start(userId: string, dto: StartPlatformInterviewDto): Promise<StartInterviewResponseDto> {
    await this.sweepStaleSessions(userId);
    const context = await this.resolveContext(userId, dto);
    const usage = this.creditAwareUsage
      ? await this.creditAwareUsage.reservePlanFirst(userId, BillingFeatureKey.INTERVIEW_SESSION)
      : await this.entitlements.reserveUsage(userId, BillingFeatureKey.INTERVIEW_SESSION);
    let session: InterviewSessionEntity | null = null;
    let sessionPersisted = false;
    try {
      const entitlements = await this.entitlements.getCurrentEntitlements(userId);
      const maxDurationSeconds = this.maxDurationSecondsForPlan(entitlements.planCode);
      const startedAt = new Date();
      const expiresAt = this.addSeconds(startedAt, maxDurationSeconds);
      const experienceMode = dto.experienceMode ?? 'MOCK';
      const language = dto.language ?? 'vi';
      const mode = dto.mode ?? 'VOICE';
      const interviewType = dto.interviewType ?? 'TECHNICAL';
      const questionBankItems = await this.loadQuestionBankItems(
        context.targetRole,
        language,
        interviewType,
      );
      const agendaCriteria = {
        language,
        targetRole: context.targetRole,
        interviewType,
        seniority: context.snapshot.interviewDifficulty.level,
      };
      const focusAreas =
        context.focusAreas.length > 0
          ? context.focusAreas
          : this.fallbackFocusAreasFromQuestionBank(
              questionBankItems,
              agendaCriteria,
              context.contextMode,
            );
      const turnBudget = this.turnBudgetForPlan(entitlements.planCode);
      const cvAgenda =
        context.contextMode === 'CV_ONLY' && context.cv?.parsedJson
          ? this.buildCvOnlyAgenda(
              context.cv.parsedJson,
              context.targetRole,
              language,
              context.snapshot.interviewDifficulty.level,
              turnBudget,
            )
          : null;
      const agenda =
        cvAgenda ??
        this.applyQuestionBankToAgenda(
          buildInterviewAgenda({
            focusAreas,
            seniority: context.snapshot.interviewDifficulty.level,
            turnBudget,
          }),
          questionBankItems,
          agendaCriteria,
          context.contextMode,
        );
      this.pinOpeningQuestion(agenda, context.contextMode, context.targetRole, language);
      const questionThreadId = randomUUID();
      const interviewState = {
        ...this.initialInterviewState(agenda),
        realtime: {
          protocolVersion: 'interview-realtime-v3',
          currentTopicId: agenda.topics[0]?.id ?? null,
          noAnswerCount: 0,
          probeCount: 0,
          topicHistory: [],
          questionFingerprints: [],
          exchanges: [],
        },
      };
      const firstTopic = agenda.topics[0];
      if (!firstTopic) {
        throw new BadRequestException({
          errorCode: ERROR_CODES.VALIDATION_ERROR,
          message: 'Interview agenda has no topics',
        });
      }

      const sessionDraft = this.sessions.create({
        userId,
        cvId: context.cv?.id ?? null,
        jobDescriptionId: context.jd?.id ?? null,
        cvMatchId: context.match?.id ?? null,
        targetRole: context.targetRole,
        language,
        mode,
        experienceMode,
        interviewType,
        voice: resolveInterviewVoice(
          dto.voice,
          this.config?.get<string>('llm.openai.realtimeVoice'),
        ),
        speechSpeed: dto.speechSpeed ?? DEFAULT_INTERVIEW_SPEECH_SPEED,
        status: 'IN_PROGRESS',
        maxDurationSeconds,
        startedAt,
        expiresAt,
        contextSnapshot: context.snapshot,
        agenda,
        interviewState,
        totalQuestionsPlanned: agenda.turn_budget,
      });
      const transactionalManager = (
        this.sessions as Repository<InterviewSessionEntity> & { manager?: EntityManager }
      ).manager;
      if (transactionalManager) {
        sessionDraft.id = randomUUID();
        session = sessionDraft;
      } else {
        session = await this.sessions.save(sessionDraft);
        sessionPersisted = true;
      }

      let firstMessage = '';
      let firstQuestion = '';
      let phase: StartInterviewResponseDto['phase'] = null;
      // The identity line is code-owned: the model may phrase the question, but it must not
      // invent a candidate name or employer in the first impression.
      firstMessage = buildInterviewOpening(context.identity, language, context.contextMode);
      firstQuestion = firstTopic.seed_question;
      const firstTurn = this.turns.create({
        sessionId: session.id,
        turnOrder: 1,
        phase: firstTopic.phase,
        topicPhase: firstTopic.phase,
        modality: session.mode === 'TEXT' ? 'TEXT' : 'AUDIO',
        aiRequestId: null,
        interviewerMessage: firstMessage,
        interviewerQuestion: firstQuestion,
        questionThreadId,
        currentThread: firstTopic.what_to_probe,
        skillCanonical: firstTopic.skill_canonical,
        questionBankItemId: firstTopic.question_bank_item_id ?? null,
        questionBankKey: firstTopic.question_bank_key ?? null,
        // the first question is always a fresh one — the opening budget, by definition.
        timeBudgetSeconds: answerTimeBudgetSeconds('opening'),
      });
      if (transactionalManager) {
        await transactionalManager.transaction(async (manager) => {
          session = await manager.getRepository(InterviewSessionEntity).save(session!);
          await manager.getRepository(InterviewTurnEntity).save(firstTurn);
        });
        sessionPersisted = true;
      } else {
        await this.turns.save(firstTurn);
      }

      phase = firstTopic.phase;
      await usage.confirm({
        sourceType: 'interview_session',
        sourceId: session.id,
      });
      let realtime: RealtimeClientSecretDto;
      try {
        realtime = await this.createRealtimeIfNeeded(
          userId,
          session,
          this.compactRealtimeContext(session),
        );
      } catch (error) {
        this.logger.warn(
          `Realtime setup failed for session ${session.id}: ${(error as Error).message}`,
        );
        realtime = {
          enabled: false,
          provider: 'openai',
          model: null,
          protocolVersion: INTERVIEW_REALTIME_PROTOCOL_VERSION,
          transcriptionModel: DEFAULT_REALTIME_TRANSCRIPTION_MODEL,
          clientSecret: null,
          expiresAt: null,
          reason: 'Realtime setup is temporarily unavailable',
        };
      }

      return {
        ...this.toSessionDto(session),
        currentTurnId: firstTurn.id,
        firstMessage,
        firstQuestion,
        phase,
        realtime,
        answerBudgetSeconds: answerTimeBudgetSeconds('opening'),
      };
    } catch (error) {
      if (!sessionPersisted) {
        await usage.refund();
      } else if (session) {
        session.status = 'FAILED';
        await this.sessions.save(session).catch((saveError) => {
          this.logger.warn(
            `Could not mark failed interview session ${session!.id}: ${(saveError as Error).message}`,
          );
        });
      }
      throw error;
    }
  }

  async end(userId: string, dto: EndPlatformInterviewDto): Promise<InterviewDetailResponseDto> {
    const session = await this.findOwnedSession(userId, dto.sessionId);
    const turns = await this.getTurns(session.id);
    const alreadyFinalized =
      session.status === 'CANCELLED' ||
      (session.status === 'COMPLETED' &&
        ((session.finalScore !== null && session.finalScore !== undefined) ||
          (session.overallScore !== null && session.overallScore !== undefined)));
    if (alreadyFinalized) {
      return {
        ...this.toSessionDto(session),
        turns: turns.map((turn) => this.toTurnDto(turn)),
      };
    }
    const inFlightFinalization = this.activeFinalizations.get(session.id);
    if (inFlightFinalization) {
      session.interviewState = this.withFinalizationState(
        session.interviewState,
        inFlightFinalization,
      );
      return {
        ...this.toSessionDto(session),
        turns: turns.map((turn) => this.toTurnDto(turn)),
      };
    }
    const activeFinalization = this.finalizationState(session);
    if (
      activeFinalization?.status === 'PENDING' &&
      Date.now() - Date.parse(activeFinalization.startedAt) < 120_000
    ) {
      return {
        ...this.toSessionDto(session),
        turns: turns.map((turn) => this.toTurnDto(turn)),
      };
    }
    const answeredTurns = turns.filter((turn) => this.hasValidStoredAnswer(turn));
    const endedAt = this.resolveEndedAt(session);
    if (answeredTurns.length === 0) {
      session.status = 'CANCELLED';
      session.endedAt = endedAt;
      session.durationSeconds = this.durationSeconds(session.startedAt, endedAt);
      const saved = await this.sessions.save(session);

      return {
        ...this.toSessionDto(saved),
        turns: turns.map((turn) => this.toTurnDto(turn)),
      };
    }

    const finalizationAttemptId = crypto.randomUUID();
    const finalizationStartedAt = new Date().toISOString();
    session.interviewState = this.withFinalizationState(session.interviewState, {
      status: 'PENDING',
      attemptId: finalizationAttemptId,
      startedAt: finalizationStartedAt,
    });
    const finalizationClaim = this.finalizationState(session);
    if (finalizationClaim) this.activeFinalizations.set(session.id, finalizationClaim);
    try {
      await this.sessions.save(session);

      const analyses = await this.ensureTurnAnalyses(userId, session, answeredTurns);
      const difficulty = this.resolveSessionInterviewDifficulty(session);
      // Wave I-SCORE: same aggregation as before, plus per-dimension explanations with evidence
      // quotes (masked inside the module) — score and explanations come from ONE pass.
      const { score, explanations } = explainInterviewScore({
        answers: this.scoringAnswers(analyses),
        role: session.targetRole,
        seniority: difficulty.level,
      });
      const contexts = analyses.map(
        (item): AnswerGapContext => ({
          topic_phase: item.topicPhase,
          skill_canonical: item.skillCanonical,
          display_name: item.displayName,
          linked_question_id: item.turn.id,
          answer_excerpt: item.turn.userAnswerText ?? '',
          signals: item.signals,
          insight: item.insight,
        }),
      );
      const probedSkills = this.probedSkillSet(analyses);
      const interviewGaps = groundInterviewGaps(
        deriveInterviewGaps(contexts),
        probedSkills.size > 0 ? probedSkills : null,
      );
      const matchGapItems = await this.loadMatchGapItems(userId, session);
      const plan = buildUnifiedPlan({
        matchId: session.cvMatchId ?? '',
        sessionId: session.id,
        gapItems: matchGapItems,
        interviewItems: interviewGaps,
      });
      const coaching = await this.coachingService!.coach(
        {
          score,
          gaps: interviewGaps,
          plan,
          language: this.language(session.language),
        },
        userId,
      );

      session.status = 'COMPLETED';
      session.endedAt = endedAt;
      session.durationSeconds = this.durationSeconds(session.startedAt, endedAt);
      // additive: score_explanations rides inside the finalScore jsonb; existing consumers of
      // overall/dimensions/role_family are untouched.
      session.finalScore = {
        ...score,
        // A zero-dimension aggregate means the rubric did not have enough valid criteria to score
        // this session. Keep the internal aggregate shape for compatibility, but do not expose 0 as
        // a real candidate score to clients.
        overall: score.score_basis === 'unscored' ? null : score.overall,
        score_explanations: explanations,
        score_basis: score.score_basis ?? 'unscored',
        scoring_note:
          score.score_basis === 'criterion_rubric'
            ? 'Overall score is derived from per-answer criterion rubrics and code-owned dimension weights.'
            : score.score_basis === 'mixed'
              ? 'Overall score combines calibrated criterion rubrics with explicitly marked legacy fallback answers.'
              : 'Overall score contains legacy fallback answers and should be treated as low-confidence.',
      };
      session.gapItems = interviewGaps;
      session.devPlan = plan;
      session.coaching = coaching;
      session.overallScore = score.score_basis === 'unscored' ? null : this.score(score.overall);
      session.semanticScore = this.score(this.dimensionScore(score, 'technical_depth'));
      session.llmScore = this.score(this.dimensionScore(score, 'evidence_credibility'));
      session.communicationScore = this.score(this.dimensionScore(score, 'communication'));
      session.aiFeedback = this.compatAiFeedback(coaching, score, plan);
      session.interviewState = this.withFinalizationState(session.interviewState, {
        status: 'READY',
        attemptId: finalizationAttemptId,
        startedAt: finalizationStartedAt,
        completedAt: new Date().toISOString(),
      });

      const saved = await this.sessions.save(session);

      return {
        ...this.toSessionDto(saved),
        turns: turns.map((turn) => this.toTurnDto(turn)),
      };
    } catch (error) {
      session.interviewState = this.withFinalizationState(session.interviewState, {
        status: 'FAILED',
        attemptId: finalizationAttemptId,
        startedAt: finalizationStartedAt,
        failedAt: new Date().toISOString(),
      });
      await this.sessions.save(session);
      throw error;
    } finally {
      this.activeFinalizations.delete(session.id);
    }
  }

  async list(
    userId: string,
    query: InterviewListQueryDto,
  ): Promise<{ items: InterviewSessionDto[]; total: number; page: number; limit: number }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const [items, total] = await this.sessions.findAndCount({
      where: query.scoredOnly
        ? {
            userId,
            status: 'COMPLETED',
            overallScore: Not(IsNull()),
          }
        : { userId },
      order: { startedAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { items: items.map((item) => this.toSessionDto(item)), total, page, limit };
  }

  async get(userId: string, sessionId: string): Promise<InterviewDetailResponseDto> {
    const session = await this.findOwnedSession(userId, sessionId);
    return {
      ...this.toSessionDto(session),
      turns: (await this.getTurns(session.id)).map((turn) => this.toTurnDto(turn)),
    };
  }

  async createRealtimeToken(userId: string, sessionId: string): Promise<RealtimeClientSecretDto> {
    const session = await this.findOwnedSession(userId, sessionId);
    this.assertInProgress(session);
    await this.assertNotExpired(session);
    const realtime = await this.createRealtimeIfNeeded(
      userId,
      session,
      await this.compactRealtimeContextWithHistory(session),
    );
    await this.sessions.save(session);
    return realtime;
  }

  private buildCvOnlyAgenda(
    document: CanonicalCvDocument,
    targetRole: string,
    language: 'vi' | 'en',
    seniority: string,
    turnBudget: number,
  ): InterviewAgenda | null {
    const evidenceScore = (bullets: string[], technologies: string[] = []): number =>
      bullets.filter(Boolean).length * 2 + technologies.filter(Boolean).length;
    const projects = [...document.projects].sort(
      (left, right) =>
        evidenceScore(right.bullets, right.tech) - evidenceScore(left.bullets, left.tech),
    );
    const experiences = [...document.experience].sort(
      (left, right) => evidenceScore(right.bullets) - evidenceScore(left.bullets),
    );
    const primaryProject = projects[0] ?? null;
    const primaryExperience = experiences[0] ?? null;
    if (!primaryProject && !primaryExperience) return null;

    const projectLabel = primaryProject?.name || primaryExperience?.org || targetRole;
    const cvText = [
      document.summary,
      ...document.skills.technical,
      ...document.skills.tools,
      ...projects.flatMap((project) => [
        project.name,
        project.role ?? '',
        ...project.tech,
        ...project.bullets,
      ]),
      ...experiences.flatMap((experience) => [
        experience.org,
        experience.role ?? '',
        ...experience.bullets,
      ]),
    ]
      .filter(Boolean)
      .join(' ');
    const canonicalSkills =
      this.skillScanner
        ?.scan(cvText)
        .sort((left, right) => right.occurrences - left.occurrences)
        .map((skill) => skill.canonical_name) ?? [];
    const canonicalFor = (text: string): string | null =>
      this.skillScanner?.scan(text)[0]?.canonical_name ?? canonicalSkills[0] ?? null;
    const topics: AgendaTopic[] = [];
    const add = (topic: AgendaTopic): void => {
      if (!topics.some((existing) => existing.id === topic.id)) topics.push(topic);
    };

    add({
      id: 'cv-project-ownership',
      phase: 'SCREENING',
      skill_canonical: canonicalFor(primaryProject?.tech.join(' ') ?? ''),
      display_name: projectLabel,
      source: 'cv',
      focus_type: 'evidence_probe',
      priority: 100,
      seniority_target: seniority,
      drill_budget: 1,
      what_to_probe: `candidate ownership in ${projectLabel}`,
      seed_question:
        language === 'vi'
          ? `Trong dự án ${projectLabel}, phần nào bạn trực tiếp phụ trách?`
          : `Which part of ${projectLabel} did you personally own?`,
      cv_evidence_excerpt: this.limit(
        [primaryProject?.role, ...(primaryProject?.bullets ?? primaryExperience?.bullets ?? [])]
          .filter(Boolean)
          .join(' '),
        500,
      ),
    });

    if (/\b(jwt|oauth|rbac|auth|authentication|authorization|session|api)\b/i.test(cvText)) {
      add({
        id: 'cv-auth-api-depth',
        phase: 'SKILL_PROBE',
        skill_canonical: canonicalFor('JWT OAuth RBAC authentication API session'),
        display_name: 'Authentication and API ownership',
        source: 'cv',
        focus_type: 'depth_probe',
        priority: 90,
        seniority_target: seniority,
        drill_budget: 2,
        what_to_probe: 'one concrete authentication, authorization, API, or session decision',
        seed_question:
          language === 'vi'
            ? `Trong ${projectLabel}, bạn đã xử lý xác thực hoặc session như thế nào?`
            : `How did you handle authentication or session management in ${projectLabel}?`,
      });
    }

    if (
      /clean architecture|entity framework|ef\s*core|sql server|postgres|database/i.test(cvText)
    ) {
      add({
        id: 'cv-architecture-data',
        phase: 'SKILL_PROBE',
        skill_canonical: canonicalFor('Clean Architecture EF Core SQL Server database'),
        display_name: 'Architecture and data access',
        source: 'cv',
        focus_type: 'depth_probe',
        priority: 80,
        seniority_target: seniority,
        drill_budget: 1,
        what_to_probe: 'one architecture or data-access decision and its trade-off',
        seed_question:
          language === 'vi'
            ? 'Bạn đã áp dụng Clean Architecture hoặc tổ chức lớp truy cập dữ liệu như thế nào?'
            : 'How did you apply Clean Architecture or organize the data-access layer?',
      });
    }

    const microservicesExperience = experiences.find((experience) =>
      /microservice|distributed|kafka|rabbitmq|service/i.test(
        `${experience.org} ${experience.role ?? ''} ${experience.bullets.join(' ')}`,
      ),
    );
    if (microservicesExperience) {
      add({
        id: 'cv-microservices-experience',
        phase: 'SKILL_PROBE',
        skill_canonical: canonicalFor(microservicesExperience.bullets.join(' ')),
        display_name: `${microservicesExperience.org} microservices experience`,
        source: 'cv',
        focus_type: 'evidence_probe',
        priority: 70,
        seniority_target: seniority,
        drill_budget: 1,
        what_to_probe: `concrete ownership at ${microservicesExperience.org}`,
        seed_question:
          language === 'vi'
            ? `Tại ${microservicesExperience.org}, bạn trực tiếp phụ trách phần nào trong hệ thống dịch vụ?`
            : `At ${microservicesExperience.org}, which part of the service system did you directly own?`,
      });
    }

    for (const skill of canonicalSkills.slice(0, 3)) {
      if (topics.some((topic) => topic.skill_canonical === skill)) continue;
      add({
        id: `cv-skill-${skill.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
        phase: 'SKILL_PROBE',
        skill_canonical: skill,
        display_name: skill,
        source: 'cv',
        focus_type: 'depth_probe',
        priority: 50,
        seniority_target: seniority,
        drill_budget: 1,
        what_to_probe: `one real implementation decision involving ${skill}`,
        seed_question:
          language === 'vi'
            ? `Bạn đã dùng ${skill} để giải quyết vấn đề cụ thể nào?`
            : `What concrete problem did you solve with ${skill}?`,
      });
    }

    add({
      id: 'cv-scenario-tradeoff',
      phase: 'SCENARIO',
      skill_canonical: canonicalSkills[0] ?? null,
      display_name: 'Scenario and trade-off',
      source: 'cv',
      focus_type: 'depth_probe',
      priority: 20,
      seniority_target: seniority,
      drill_budget: 1,
      what_to_probe: 'one realistic trade-off grounded in the candidate profile',
      seed_question:
        language === 'vi'
          ? 'Nếu tính năng bạn vừa mô tả gặp tải tăng đột biến, bạn sẽ ưu tiên kiểm tra điều gì trước?'
          : 'If the feature you described suddenly faced much higher load, what would you inspect first?',
    });
    add({
      id: 'cv-behavioral',
      phase: 'BEHAVIORAL',
      skill_canonical: null,
      display_name: 'Behavioral ownership',
      source: 'cv',
      focus_type: 'evidence_probe',
      priority: 10,
      seniority_target: seniority,
      drill_budget: 1,
      what_to_probe: 'ownership and collaboration in one difficult situation',
      seed_question:
        language === 'vi'
          ? 'Hãy kể về một lần bạn phải phối hợp với người khác để xử lý một vấn đề khó.'
          : 'Tell me about one time you collaborated with others to resolve a difficult problem.',
    });

    const selected = topics.slice(0, Math.max(4, Math.min(turnBudget, topics.length)));
    return {
      topics: selected,
      turn_budget: selected.length,
      uncovered: topics.slice(selected.length),
    };
  }

  private pinOpeningQuestion(
    agenda: InterviewAgenda,
    contextMode: InterviewContextMode,
    targetRole: string,
    language: 'vi' | 'en',
  ): void {
    const first = agenda.topics[0];
    if (!first || contextMode !== 'ROLE_ONLY') return;
    first.seed_question =
      language === 'vi'
        ? `Hãy kể ngắn về một dự án gần đây liên quan đến vị trí ${targetRole}.`
        : `Briefly describe a recent project related to the ${targetRole} role.`;
    first.what_to_probe = 'one recent project before a single contextual ownership follow-up';
    first.question_bank_item_id = undefined;
    first.question_bank_key = undefined;
    first.question_source = undefined;
  }
  private initialInterviewState(agenda: InterviewAgenda): InterviewState {
    const first = agenda.topics[0];
    return {
      current_phase: first.phase,
      current_topic_id: first.id,
      drill_depth: 0,
      current_thread: first.what_to_probe,
      running_notes: [],
      covered_topic_ids: [],
      uncovered_topic_ids: agenda.uncovered.map((topic) => topic.id),
      turns_used: 0,
      evasive_streak: 0,
    };
  }

  private async loadQuestionBankItems(
    targetRole: string,
    language: 'vi' | 'en',
    interviewType: InterviewType,
  ): Promise<InterviewQuestionBankCandidate[]> {
    const normalizedRole = normalizeQuestionBankTargetRole(targetRole);
    if (!this.questionBankItems) return [];
    try {
      const rows = await this.questionBankItems.find({
        where: {
          active: true,
          language,
          targetRole: normalizedRole,
        },
        order: { priority: 'DESC', questionKey: 'ASC' },
      });
      const filtered = rows.filter(
        (row) =>
          row.interviewType === interviewType ||
          row.interviewType === 'MIXED' ||
          interviewType === 'MIXED',
      );
      return filtered.length > 0
        ? filtered
        : this.seedQuestionBankItems(normalizedRole, language, interviewType);
    } catch (error) {
      this.logger.error(
        `Failed to load interview question bank items for ${normalizedRole}/${language}/${interviewType}`,
        error instanceof Error ? error.stack : String(error),
      );
      return [];
    }
  }

  private seedQuestionBankItems(
    targetRole: string,
    language: 'vi' | 'en',
    interviewType: InterviewType,
  ): InterviewQuestionBankCandidate[] {
    const normalizedRole = normalizeQuestionBankTargetRole(targetRole);
    if (!this.isKnownQuestionBankRole(normalizedRole)) return [];

    return this.allSeedQuestionBankItems().filter(
      (seed) =>
        seed.active &&
        seed.language === language &&
        seed.targetRole === normalizedRole &&
        (seed.interviewType === interviewType ||
          seed.interviewType === 'MIXED' ||
          interviewType === 'MIXED'),
    );
  }

  private allSeedQuestionBankItems(): InterviewQuestionBankCandidate[] {
    cachedQuestionBankSeedItems ??= buildInterviewQuestionBankSeeds().map((seed) => ({
      ...seed,
      id: `seed:${seed.questionKey}:${seed.language}`,
    }));
    return cachedQuestionBankSeedItems;
  }

  private isKnownQuestionBankRole(value: string): boolean {
    return QUESTION_BANK_TARGET_ROLES.includes(
      value as (typeof QUESTION_BANK_TARGET_ROLES)[number],
    );
  }

  private fallbackFocusAreasFromQuestionBank(
    questionBankItems: InterviewQuestionBankCandidate[],
    criteria: {
      language: 'vi' | 'en';
      targetRole: string;
      interviewType: InterviewType;
      seniority: string;
    },
    contextMode: InterviewContextMode,
  ): InterviewFocusArea[] {
    const normalizedRole = normalizeQuestionBankTargetRole(criteria.targetRole);
    if (!this.isKnownQuestionBankRole(normalizedRole)) return [];

    const cvOrRoleOnly = contextMode !== 'CV_JD_MATCH';
    const seniority = criteria.seniority.trim().toLowerCase();
    const phaseRank: Partial<Record<AgendaInterviewPhase, number>> = {
      SKILL_PROBE: 1,
      JD_REQUIREMENT: cvOrRoleOnly ? 99 : 2,
      SCENARIO: 3,
    };
    const focusRank: Record<InterviewFocusArea['focus_type'], number> = {
      gap_probe: 1,
      evidence_probe: 2,
      depth_probe: 3,
      strength_showcase: 4,
    };
    const selected: InterviewFocusArea[] = [];
    const usedSkills = new Set<string>();

    const candidates = questionBankItems
      .filter(
        (candidate) =>
          candidate.active &&
          candidate.language === criteria.language &&
          normalizeQuestionBankTargetRole(candidate.targetRole) === normalizedRole &&
          (candidate.interviewType === criteria.interviewType ||
            candidate.interviewType === 'MIXED' ||
            criteria.interviewType === 'MIXED') &&
          candidate.skillCanonical &&
          candidate.phase !== 'SCREENING' &&
          candidate.phase !== 'WRAP' &&
          (!cvOrRoleOnly || candidate.phase !== 'JD_REQUIREMENT') &&
          (!cvOrRoleOnly || !this.hasContextSpecificQuestion(candidate.questionText)) &&
          (!candidate.seniority || candidate.seniority.trim().toLowerCase() === seniority),
      )
      .sort((a, b) => {
        const phaseDiff = (phaseRank[a.phase] ?? 99) - (phaseRank[b.phase] ?? 99);
        if (phaseDiff !== 0) return phaseDiff;
        const aFocus = this.focusTypeForBankCandidate(a);
        const bFocus = this.focusTypeForBankCandidate(b);
        const focusDiff = focusRank[aFocus] - focusRank[bFocus];
        if (focusDiff !== 0) return focusDiff;
        if (b.priority !== a.priority) return b.priority - a.priority;
        return a.questionKey.localeCompare(b.questionKey);
      });

    for (const candidate of candidates) {
      const skill = candidate.skillCanonical;
      if (!skill || usedSkills.has(skill)) continue;
      usedSkills.add(skill);
      const displayName = this.displayNameFromSkill(skill);
      const focusType = cvOrRoleOnly
        ? 'strength_showcase'
        : this.focusTypeForBankCandidate(candidate);
      const reason =
        contextMode === 'ROLE_ONLY'
          ? `Role-only practice for ${displayName}. No CV or job description was provided.`
          : contextMode === 'CV_ONLY'
            ? `CV-only practice for ${displayName}. Use the candidate CV when available; no job description was provided.`
            : `Role-based question bank fallback for ${displayName}. ${candidate.sourceBasis}`;
      selected.push({
        skill_canonical: skill,
        display_name: displayName,
        focus_type: focusType,
        reason,
        difficulty: candidate.difficulty <= 2 ? 'foundation' : 'applied',
        template_question: cvOrRoleOnly
          ? this.safeContextTemplateQuestion(
              criteria.language,
              criteria.targetRole,
              displayName,
              contextMode,
            )
          : candidate.questionText,
      });
      if (selected.length >= 6) break;
    }

    return selected;
  }

  private focusTypeForBankCandidate(
    candidate: InterviewQuestionBankCandidate,
  ): InterviewFocusArea['focus_type'] {
    if (candidate.focusType) return candidate.focusType;
    if (candidate.phase === 'SKILL_PROBE' || candidate.phase === 'SCENARIO') return 'depth_probe';
    return 'gap_probe';
  }

  private safeContextTemplateQuestion(
    language: 'vi' | 'en',
    targetRole: string,
    displayName: string,
    contextMode: InterviewContextMode,
  ): string {
    const roleLabel = this.displayNameFromSkill(normalizeQuestionBankTargetRole(targetRole));
    if (contextMode === 'CV_ONLY') {
      if (language === 'vi') {
        return `Dựa trên CV hoặc dự án gần đây của bạn cho vai trò ${roleLabel}, hãy mô tả một ví dụ cụ thể liên quan đến ${displayName}. Bạn phụ trách gì, quyết định ra sao, và kết quả thế nào?`;
      }
      return `From your CV or recent projects for a ${roleLabel} role, describe a concrete example involving ${displayName}. What did you own, what decisions did you make, and what was the result?`;
    }
    if (language === 'vi') {
      return `Cho vai trò ${roleLabel}, hãy mô tả một ví dụ thực tế hoặc bài luyện tập liên quan đến ${displayName}. Bạn đã làm gì, gặp khó khăn gì, và rút ra điều gì?`;
    }
    return `For a ${roleLabel} role, describe a real or practice example involving ${displayName}. What did you do, what was hard, and what did you learn?`;
  }

  private displayNameFromSkill(skill: string): string {
    return skill
      .split(/[_-]+/g)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  private hasContextSpecificQuestion(question: string): boolean {
    return CONTEXT_SPECIFIC_QUESTION_PATTERN.test(question);
  }

  private applyQuestionBankToAgenda(
    agenda: InterviewAgenda,
    questionBankItems: InterviewQuestionBankCandidate[],
    criteria: {
      language: 'vi' | 'en';
      targetRole: string;
      interviewType: 'HR' | 'TECHNICAL' | 'MIXED';
      seniority: string;
    },
    contextMode: InterviewContextMode,
  ): InterviewAgenda {
    const usedQuestionKeys = new Set<string>();
    const usedFingerprints = new Set<string>();
    const fingerprint = (question: string): string =>
      Array.from(question.normalize('NFKD'))
        .filter((character) => {
          const code = character.charCodeAt(0);
          return code < 768 || code > 879;
        })
        .join('')
        .toLowerCase()
        .replace(/[^a-z0-9+#.]+/g, ' ')
        .trim();

    const enrich = (topic: AgendaTopic): AgendaTopic => {
      const eligible = questionBankItems.filter((candidate) => {
        if (usedQuestionKeys.has(candidate.questionKey)) return false;
        if (usedFingerprints.has(fingerprint(candidate.questionText))) return false;
        return !(
          contextMode === 'ROLE_ONLY' && this.hasContextSpecificQuestion(candidate.questionText)
        );
      });
      const skillSpecific = topic.skill_canonical
        ? eligible.filter((candidate) => candidate.skillCanonical === topic.skill_canonical)
        : eligible;
      if (topic.skill_canonical && skillSpecific.length === 0) return topic;

      const selected = selectInterviewQuestion(skillSpecific, {
        language: criteria.language,
        targetRole: criteria.targetRole,
        interviewType: criteria.interviewType,
        phase: topic.phase,
        skillCanonical: topic.skill_canonical,
        focusType: topic.skill_canonical ? null : (topic.focus_type ?? null),
        seniority: criteria.seniority,
      });
      if (!selected) return topic;

      usedQuestionKeys.add(selected.questionKey);
      usedFingerprints.add(fingerprint(selected.questionText));
      return {
        ...topic,
        seed_question: selected.questionText,
        question_bank_item_id: selected.id,
        question_bank_key: selected.questionKey,
        question_source: selected.sourceKind,
        rubric_dimensions: selected.rubricDimensions,
        expected_signals: selected.expectedSignals,
      };
    };

    return {
      ...agenda,
      topics: agenda.topics.map(enrich),
      uncovered: agenda.uncovered.map(enrich),
    };
  }
  private async ensureTurnAnalyses(
    userId: string,
    session: InterviewSessionEntity,
    turns: InterviewTurnEntity[],
  ): Promise<FinalizedTurnAnalysis[]> {
    const out: FinalizedTurnAnalysis[] = [];
    for (let index = 0; index < turns.length; index += 3) {
      const batch = turns.slice(index, index + 3);
      out.push(
        ...(await Promise.all(batch.map((turn) => this.ensureTurnAnalysis(userId, session, turn)))),
      );
    }
    return out;
  }

  private scoringAnswers(analyses: FinalizedTurnAnalysis[]): Array<{
    topic_phase: AgendaInterviewPhase;
    score: number;
    depth_signal: DepthSignal;
    score_source: 'criterion_rubric' | 'legacy_llm' | 'unscored' | undefined;
    dimension_scores: Partial<Record<Dimension, number>>;
    dimension_score_sources: Partial<
      Record<Dimension, 'criterion_rubric' | 'legacy_llm' | 'unscored'>
    >;
    evidence_excerpt: string | undefined;
    linked_question_id: string;
  }> {
    const groups = collapseQuestionThreads(
      analyses.map((analysis) => ({
        id: analysis.turn.id,
        threadId: analysis.turn.questionThreadId ?? null,
        order: analysis.turn.turnOrder,
        scoreCap: analysis.turn.scoreCap ?? null,
        analysis,
      })),
    );

    return groups.flatMap((group) => {
      const representative = group.representative.analysis;
      if (!representative.depthSignal) return [];

      const rawScores = group.items
        .map((item) => item.analysis.score)
        .filter((score): score is number => typeof score === 'number' && Number.isFinite(score));
      const dimensions = new Set<Dimension>();
      for (const item of group.items) {
        for (const dimension of Object.keys(item.analysis.scoreAssessments) as Dimension[]) {
          dimensions.add(dimension);
        }
      }

      const dimensionScores: Partial<Record<Dimension, number>> = {};
      const dimensionSources: Partial<
        Record<Dimension, 'criterion_rubric' | 'legacy_llm' | 'unscored'>
      > = {};
      for (const dimension of dimensions) {
        const assessments = group.items
          .map((item) => item.analysis.scoreAssessments[dimension])
          .filter((assessment): assessment is CalibratedAnswerScore => Boolean(assessment));
        const values = assessments
          .map((assessment) => assessment.score)
          .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
        if (values.length === 0) continue;
        const average = Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
        dimensionScores[dimension] = applyScoreCap(average, group.scoreCap) as number;
        dimensionSources[dimension] =
          assessments.find((assessment) => assessment.source === 'criterion_rubric')?.source ??
          assessments[assessments.length - 1]?.source ??
          'unscored';
      }

      const rawScore =
        rawScores.length > 0
          ? Math.round(rawScores.reduce((sum, value) => sum + value, 0) / rawScores.length)
          : Object.values(dimensionScores)[0];
      const cappedScore = applyScoreCap(rawScore ?? null, group.scoreCap);
      if (cappedScore === null) return [];

      const evidence = group.items
        .map((item) => item.analysis.turn.userAnswerText?.trim())
        .filter((value): value is string => Boolean(value))
        .join('\n');
      return [
        {
          topic_phase: representative.topicPhase,
          score: cappedScore,
          depth_signal: representative.depthSignal,
          score_source: representative.scoreAssessment?.source,
          dimension_scores: dimensionScores,
          dimension_score_sources: dimensionSources,
          evidence_excerpt: evidence || undefined,
          linked_question_id: representative.turn.id,
        },
      ];
    });
  }

  private async ensureTurnAnalysis(
    userId: string,
    session: InterviewSessionEntity,
    turn: InterviewTurnEntity,
  ): Promise<FinalizedTurnAnalysis> {
    const topicPhase = this.resolveTurnTopicPhase(turn);
    const skillCanonical = turn.skillCanonical ?? null;
    const displayName = this.displayNameForTurn(turn, topicPhase);
    let signals = this.maybeSignals(turn.signals);
    let insight = this.maybeInsight(turn.insight);
    let score = this.numberOrNull(turn.perQuestionScore);
    let depthSignal = this.maybeDepthSignal(turn.depthSignal);
    const rubricDimensions = topicDimensions(topicPhase);
    const targetDimensions =
      rubricDimensions.length > 0 ? rubricDimensions : ['communication' as Dimension];
    const targetDimension = targetDimensions[0];
    let scoreAssessments =
      this.scoreAssessmentsFromInsight(turn.insight) ??
      this.scoreAssessmentsFromInsight(turn.turnTrace) ??
      {};
    let scoreAssessment =
      this.scoreAssessmentFromInsight(turn.insight) ??
      this.scoreAssessmentFromInsight(turn.turnTrace);
    if (Object.keys(scoreAssessments).length === 0 && scoreAssessment) {
      scoreAssessments = { [targetDimension]: scoreAssessment };
    }
    if (score === null) score = averageCalibratedScores(scoreAssessments);

    if (!signals || !insight || score === null || !depthSignal) {
      const assessment = await this.interviewChain!.assess(userId, {
        sessionId: session.id,
        turnOrder: turn.turnOrder,
        language: this.language(session.language),
        seniorityTarget: this.resolveSessionInterviewDifficulty(session).level,
        currentTopic: {
          phase: topicPhase,
          display_name: displayName,
          skill_canonical: skillCanonical,
        },
        targetDimensions,
        targetDimension,
        currentThread: turn.currentThread ?? displayName,
        drillDepth: 0,
        recentQa: [
          {
            order: turn.turnOrder,
            question: turn.interviewerQuestion,
            answer: maskPii(turn.userAnswerText ?? ''),
          },
        ],
        interviewContext: this.interviewContextForSession(session),
      });
      signals = analyzeAnswerSignals({
        answer: turn.userAnswerText ?? '',
        question: turn.interviewerQuestion,
        jd_terms: skillCanonical ? [skillCanonical, displayName] : [],
        language: this.language(session.language),
      });
      insight = await this.answerInsight!.judge(
        {
          answer: turn.userAnswerText ?? '',
          question: turn.interviewerQuestion,
          target_dimension: targetDimension,
          language: this.language(session.language),
          signals,
        },
        userId,
      );
      // same I-CONSIST guards as the live answer path — recomputed turns get reconciled too.
      depthSignal = reconcileDepthSignal({
        depth_signal: assessment.depthSignal,
        is_too_short: signals.flags.is_too_short,
      }).depth_signal;
      scoreAssessments = calibrateInterviewAnswerScores({
        dimensions: targetDimensions,
        criteria: assessment.criterionScores ?? [],
        legacyScore:
          assessment.scoreSource === 'criterion_rubric' || assessment.scoreSource === 'unscored'
            ? null
            : assessment.score,
        depthSignal,
        offTopic: insight.off_topic,
        claimStatus: assessment.claimStatus,
      });
      scoreAssessment = scoreAssessments[targetDimension] ?? null;
      score = averageCalibratedScores(scoreAssessments);
      turn.aiRequestId = turn.aiRequestId ?? assessment.aiRequestId;
      turn.perQuestionScore = this.score(score);
      turn.depthSignal = depthSignal;
      turn.signals = signals;
      turn.insight = insight;
      turn.turnTrace = {
        ...(turn.turnTrace && typeof turn.turnTrace === 'object' ? turn.turnTrace : {}),
        score_assessment: scoreAssessment,
        score_assessments: scoreAssessments,
      } as unknown as InterviewTurnTrace;
      turn.topicPhase = topicPhase;
      turn.skillCanonical = skillCanonical;
      turn.currentThread = groundInterviewThread({
        proposed_thread: assessment.currentThread,
        previous_thread: turn.currentThread ?? '',
        answer: turn.userAnswerText ?? '',
        question: turn.interviewerQuestion,
        topic: [displayName, skillCanonical].filter(Boolean).join(' '),
      }).thread;
      await this.turns.save(turn);
    }

    if (!scoreAssessment && score !== null && depthSignal && insight) {
      scoreAssessment =
        calibrateInterviewAnswerScores({
          dimensions: targetDimensions,
          criteria: [],
          legacyScore: score,
          depthSignal,
          offTopic: insight.off_topic,
        })[targetDimension] ?? null;
      scoreAssessments = scoreAssessment ? { [targetDimension]: scoreAssessment } : {};
    }

    return {
      turn,
      topicPhase,
      skillCanonical,
      displayName,
      score,
      depthSignal,
      signals,
      insight,
      scoreAssessments,
      scoreAssessment,
    };
  }

  private resolveTurnTopicPhase(turn: InterviewTurnEntity): AgendaInterviewPhase {
    const phase = turn.phase as string | null;
    if (this.isAgendaPhase(turn.topicPhase)) return turn.topicPhase;
    if (this.isAgendaPhase(phase)) return phase;
    if (phase === 'SCENARIO') return 'SCENARIO';
    if (phase === 'BEHAVIORAL') return 'BEHAVIORAL';
    if (phase === 'WRAP_UP') return 'WRAP';
    if (turn.turnOrder === 1) return 'SCREENING';
    return 'SKILL_PROBE';
  }

  private displayNameForTurn(turn: InterviewTurnEntity, topicPhase: AgendaInterviewPhase): string {
    if (turn.skillCanonical) return turn.skillCanonical;
    if (turn.currentThread) return turn.currentThread;
    return topicPhase === 'SCREENING' ? 'Screening' : `Question ${turn.turnOrder}`;
  }

  private maybeSignals(value: unknown): AnswerSignals | null {
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Partial<AnswerSignals>;
    return candidate.jd_term_hits && candidate.filler && candidate.flags
      ? (value as AnswerSignals)
      : null;
  }

  private maybeInsight(value: unknown): AnswerInsight | null {
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Partial<AnswerInsight>;
    return candidate.evidence_quality && candidate.star_present ? (value as AnswerInsight) : null;
  }

  private scoreAssessmentFromInsight(value: unknown): CalibratedAnswerScore | null {
    if (!value || typeof value !== 'object') return null;
    const candidate = (value as Record<string, unknown>).score_assessment;
    return this.parseCalibratedAnswerScore(candidate);
  }

  private scoreAssessmentsFromInsight(value: unknown): CalibratedAnswerScores | null {
    if (!value || typeof value !== 'object') return null;
    const candidate = (value as Record<string, unknown>).score_assessments;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const dimensions: Dimension[] = [
      'technical_depth',
      'problem_solving',
      'communication',
      'evidence_credibility',
      'role_fit',
    ];
    const parsed = Object.fromEntries(
      dimensions
        .map(
          (dimension) =>
            [
              dimension,
              this.parseCalibratedAnswerScore((candidate as Record<string, unknown>)[dimension]),
            ] as const,
        )
        .filter(([, assessment]) => assessment !== null),
    ) as CalibratedAnswerScores;
    return Object.keys(parsed).length > 0 ? parsed : null;
  }

  private parseCalibratedAnswerScore(value: unknown): CalibratedAnswerScore | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const assessment = value as Partial<CalibratedAnswerScore>;
    const validSource =
      assessment.source === 'criterion_rubric' ||
      assessment.source === 'legacy_llm' ||
      assessment.source === 'unscored';
    const validCoverage =
      assessment.criteriaCoverage === 'complete' ||
      assessment.criteriaCoverage === 'partial' ||
      assessment.criteriaCoverage === 'missing';
    if (
      !validSource ||
      !validCoverage ||
      !Array.isArray(assessment.criteria) ||
      !Array.isArray(assessment.missingCriteria) ||
      !Array.isArray(assessment.reasons)
    ) {
      return null;
    }
    return assessment as CalibratedAnswerScore;
  }

  private maybeDepthSignal(value: unknown): DepthSignal | null {
    return value === 'shallow' || value === 'adequate' || value === 'deep' || value === 'evasive'
      ? value
      : null;
  }

  private isAgendaPhase(value: unknown): value is AgendaInterviewPhase {
    return (
      value === 'SCREENING' ||
      value === 'SKILL_PROBE' ||
      value === 'JD_REQUIREMENT' ||
      value === 'SCENARIO' ||
      value === 'BEHAVIORAL' ||
      value === 'WRAP'
    );
  }

  private probedSkillSet(analyses: FinalizedTurnAnalysis[]): Set<string> {
    return new Set(
      analyses
        .map((item) => item.skillCanonical)
        .filter((skill): skill is string => Boolean(skill)),
    );
  }

  private async loadMatchGapItems(
    userId: string,
    session: InterviewSessionEntity,
  ): Promise<GapItem[]> {
    if (!session.cvMatchId || !this.cvMatches) return [];
    try {
      return (
        await this.cvMatches.getGapReport(
          userId,
          session.cvMatchId,
          this.language(session.language),
        )
      ).gap_items;
    } catch {
      return [];
    }
  }

  private dimensionScore(score: InterviewScore, dimension: Dimension): number | null {
    return score.dimensions.find((item) => item.dimension === dimension)?.score ?? null;
  }

  /**
   * Legacy-compat aiFeedback: the FE still renders the pre-rubric panels
   * (technical_delivery / communication_flow / recommendations / suggested_modules), which the
   * new end path left permanently empty. Map the DETERMINISTIC rubric outputs into that shape —
   * only dimensions we actually scored are emitted (honest keys, no fabricated sub-metrics like
   * the legacy code_quality), recommendations are the code-owned coaching priority titles, and
   * suggested_modules are the devPlan learn items (cap 5). No LLM.
   */
  private compatAiFeedback(
    coaching: InterviewCoaching,
    score: InterviewScore,
    plan: UnifiedDevelopmentPlan,
  ): Record<string, unknown> {
    const rounded = (dimension: Dimension): Record<string, number> => {
      const found = score.dimensions.find((item) => item.dimension === dimension);
      return found ? { [dimension]: Math.round(found.score) } : {};
    };
    return {
      summary: coaching.summary,
      strengths: coaching.strengths,
      priorities: coaching.priorities,
      technical_delivery: { ...rounded('technical_depth'), ...rounded('problem_solving') },
      communication_flow: rounded('communication'),
      recommendations: coaching.priorities.map((priority) => priority.title),
      suggested_modules: plan.learn_items.slice(0, 5).map((item) => item.display_name),
    };
  }

  private async resolveContext(
    userId: string,
    dto: StartPlatformInterviewDto,
  ): Promise<InterviewContext> {
    const match = dto.cvMatchId
      ? await this.matches.findOne({ where: { id: dto.cvMatchId } })
      : null;
    if (dto.cvMatchId && !match) throw new NotFoundException('CV match not found');

    if (dto.cvId && match && match.cvId !== dto.cvId) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.VALIDATION_ERROR,
        message: 'CV match does not belong to the selected CV',
      });
    }

    const cvId = match?.cvId ?? dto.cvId ?? null;
    const cv = cvId
      ? await this.cvs.findOne({ where: { id: cvId, userId, deletedAt: IsNull() } })
      : null;
    if (cvId && !cv) throw new NotFoundException('CV not found');

    const jdId = match?.jobDescriptionId ?? dto.jobDescriptionId ?? null;
    const jd = jdId
      ? await this.jobDescriptions.findOne({
          where: [
            { id: jdId, userId },
            { id: jdId, userId: IsNull() },
          ],
        })
      : null;
    if (jdId && !jd) throw new NotFoundException('Job description not found');

    const targetRole = this.trimOrNull(dto.targetRole) ?? this.trimOrNull(cv?.targetRole);
    if (!targetRole) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.VALIDATION_ERROR,
        message: 'targetRole is required',
      });
    }

    const interviewDifficulty = this.resolveInterviewDifficulty(cv, jd, targetRole);
    const contextMode: InterviewContextMode = match ? 'CV_JD_MATCH' : cv ? 'CV_ONLY' : 'ROLE_ONLY';
    const identity = resolveInterviewIdentity({
      cv: cv
        ? {
            parsedJson: cv.parsedJson,
            parsedText: cv.parsedText,
            targetRole: cv.targetRole,
            title: cv.title,
          }
        : null,
      jd,
      targetRole,
    });
    const snapshot: InterviewContextSnapshot = {
      contextMode,
      identity,
      cv: cv ? { id: cv.id, title: cv.title, targetRole: cv.targetRole } : null,
      jobDescription: jd ? { id: jd.id, title: jd.title, sourceType: jd.sourceType } : null,
      cvMatch: match
        ? {
            id: match.id,
            overallScore: match.overallScore,
            strengths: match.strengths,
            weaknesses: match.weaknesses,
            suggestions: match.suggestions,
          }
        : null,
      targetRole,
      interviewDifficulty,
    };

    // Best-effort: the SAME canonical, severity-ranked gap focus areas the prep-plan uses, so the live
    // interviewer probes the real gaps (not just the raw match weaknesses). Never blocks interview start.
    const lang = dto.language === 'en' ? 'en' : 'vi';
    let focusAreas: InterviewFocusArea[] = [];
    if (match && this.cvMatches) {
      try {
        focusAreas = await this.cvMatches.getInterviewFocusAreas(userId, match.id, lang);
      } catch {
        focusAreas = [];
      }
    }

    const promptContext = this.buildPromptContext(
      cv,
      jd,
      match,
      targetRole,
      focusAreas,
      interviewDifficulty,
      contextMode,
      identity,
    );
    snapshot.interviewContext = maskPii(promptContext);

    return {
      contextMode,
      identity,
      cv,
      match,
      jd,
      focusAreas,
      targetRole,
      snapshot,
      promptContext,
    };
  }

  private buildPromptContext(
    cv: CvEntity | null,
    jd: JobDescriptionEntity | null,
    match: CvMatchEntity | null,
    targetRole: string,
    focusAreas: InterviewFocusArea[],
    interviewDifficulty: InterviewDifficultyProfile,
    contextMode: InterviewContextMode,
    identity: InterviewIdentity,
  ): string {
    const gapFocus = formatGapFocusForPrompt(focusAreas);
    const identityLines = [
      `Candidate name: ${identity.candidateName ?? 'not available'}`,
      `Interview role: ${identity.jobTitle}`,
      identity.employerName
        ? `Employer explicitly identified by the JD: ${identity.employerName}`
        : 'Employer: not identified in the JD; do not invent one',
    ].join('\n');
    if (contextMode === 'ROLE_ONLY') {
      return [
        `Interview identity:\n${identityLines}`,
        `Target role: ${targetRole}`,
        'Interview context: role-only practice based on the target role and live candidate answers.',
        `Interview difficulty profile:\n${this.formatInterviewDifficultyInstruction(interviewDifficulty)}`,
        'Interview rule: ask one question at a time and use only role-relevant examples the candidate shares live. Never imply that external candidate documents exist.',
      ].join('\n\n');
    }

    if (contextMode === 'CV_ONLY') {
      return [
        `Interview identity:\n${identityLines}`,
        `Target role: ${targetRole}`,
        'Interview context: candidate-profile practice grounded only in the provided resume.',
        `Interview difficulty profile:\n${this.formatInterviewDifficultyInstruction(interviewDifficulty)}`,
        cv?.parsedText ? `Candidate CV excerpt:\n${this.limit(cv.parsedText, 4000)}` : '',
        'Interview rule: ask one question at a time and ground questions only in profile projects, skills, and experience.',
      ]
        .filter(Boolean)
        .join('\n\n');
    }

    return [
      `Interview identity:\n${identityLines}`,
      `Target role: ${targetRole}`,
      'Interview context: CV/JD match practice. Use the CV, JD, and match/gap context when available.',
      `Interview difficulty profile:\n${this.formatInterviewDifficultyInstruction(interviewDifficulty)}`,
      jd ? `Job description title: ${jd.title ?? '(untitled)'}` : 'Job description: not provided',
      jd?.rawText ? `Job description excerpt:\n${this.limit(jd.rawText, 3000)}` : '',
      cv?.parsedText ? `Candidate CV excerpt:\n${this.limit(cv.parsedText, 4000)}` : '',
      match?.strengths ? `CV/JD matched strengths:\n${JSON.stringify(match.strengths)}` : '',
      // Prefer the canonical gap focus areas (severity-ranked); fall back to raw match weaknesses.
      gapFocus ||
        (match?.weaknesses ? `CV/JD gaps to probe:\n${JSON.stringify(match.weaknesses)}` : ''),
      match?.suggestions ? `Tailoring suggestions:\n${JSON.stringify(match.suggestions)}` : '',
      'Interview rule: ask one question at a time, probe the most important job gaps first, and adapt to the candidate answer.',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private async createRealtimeIfNeeded(
    userId: string,
    session: InterviewSessionEntity,
    context: string,
  ): Promise<RealtimeClientSecretDto> {
    if (session.mode === 'TEXT') {
      return {
        enabled: false,
        provider: 'openai',
        model: null,
        protocolVersion: INTERVIEW_REALTIME_PROTOCOL_VERSION,
        transcriptionModel: DEFAULT_REALTIME_TRANSCRIPTION_MODEL,
        clientSecret: null,
        expiresAt: null,
        reason: 'Text-only interview does not need a realtime token',
      };
    }
    return this.realtime.createClientSecret(
      userId,
      session,
      this.realtimeInstructions(session, context),
    );
  }

  private realtimeInstructions(session: InterviewSessionEntity, context?: string): string {
    const difficulty = this.resolveSessionInterviewDifficulty(session, context);
    const difficultyInstruction = this.formatInterviewDifficultyInstruction(difficulty);
    const languageInstruction =
      session.language === 'vi'
        ? 'Speak and respond only in Vietnamese with correct Vietnamese diacritics. Preserve English technical terms such as React, TypeScript, API, cache, transaction, and backend exactly as written.'
        : 'Speak and respond only in English.';
    if (!this.prompts) {
      throw new Error('PromptsService is required for realtime interview instructions');
    }
    return this.prompts.render('interview_realtime_v3', {
      context: context ?? '',
      context_block: context ? `Context:\n${context}` : '',
      difficulty_instruction: difficultyInstruction,
      agenda_checkpoint: this.publicAgendaCheckpoint(
        session.agenda,
        session.language === 'en' ? 'en' : 'vi',
      ),
      interview_type: session.interviewType,
      language: session.language,
      language_instruction: languageInstruction,
      target_role: session.targetRole,
    });
  }

  private async compactRealtimeContextWithHistory(
    session: InterviewSessionEntity,
  ): Promise<string> {
    const base = this.compactRealtimeContext(session);
    const turns =
      (await this.turns.find({
        where: { sessionId: session.id },
        order: { turnOrder: 'DESC' },
        take: 4,
      })) ?? [];
    const history = [...turns]
      .reverse()
      .map((turn) =>
        [
          `Alex: ${this.limit(turn.interviewerQuestion, 500)}`,
          turn.userAnswerText ? `Candidate: ${this.limit(maskPii(turn.userAnswerText), 700)}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      )
      .join('\n\n');
    const state =
      session.interviewState && typeof session.interviewState === 'object'
        ? (session.interviewState as Record<string, unknown>)
        : {};
    const realtime =
      state.realtime && typeof state.realtime === 'object'
        ? (state.realtime as Record<string, unknown>)
        : {};
    const checkpoint = [
      typeof realtime.currentTopicId === 'string'
        ? `Current checkpoint: ${realtime.currentTopicId}`
        : '',
      Array.isArray(realtime.topicHistory)
        ? `Completed checkpoints: ${realtime.topicHistory
            .filter((value): value is string => typeof value === 'string')
            .slice(-8)
            .join(', ')}`
        : '',
      turns[0]?.interviewerQuestion
        ? `Current question: ${this.limit(turns[0].interviewerQuestion, 500)}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');
    return [
      base,
      checkpoint ? `Reconnect checkpoint:\n${checkpoint}` : '',
      history ? `Recent exchanges (oldest to newest):\n${history}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  }
  private publicAgendaCheckpoint(value: unknown, language: 'vi' | 'en'): string {
    const agenda =
      value && typeof value === 'object' ? (value as { topics?: unknown }).topics : null;
    if (!Array.isArray(agenda)) return language === 'vi' ? '- Dự án gần đây' : '- Recent project';
    return agenda
      .filter(
        (topic): topic is Record<string, unknown> => Boolean(topic) && typeof topic === 'object',
      )
      .slice(0, 8)
      .map((topic, index) => {
        const phase = typeof topic.phase === 'string' ? topic.phase : 'SKILL_PROBE';
        const focus =
          typeof topic.display_name === 'string'
            ? topic.display_name
            : typeof topic.skill_canonical === 'string'
              ? topic.skill_canonical
              : language === 'vi'
                ? 'kinh nghiệm liên quan'
                : 'relevant experience';
        return `${index + 1}. ${phase}: ${focus}`;
      })
      .join('\n');
  }
  private compactRealtimeContext(session: InterviewSessionEntity): string {
    const snapshot = this.asContextSnapshot(session.contextSnapshot);
    if (snapshot?.interviewContext) {
      return snapshot.interviewContext;
    }
    const contextMode = this.contextModeFromSession(session);
    if (contextMode === 'ROLE_ONLY') {
      return [
        `Target role: ${session.targetRole}`,
        'Context mode: role-only practice grounded in the target role and live answers.',
        snapshot?.interviewDifficulty
          ? `Interview difficulty profile:\n${this.formatInterviewDifficultyInstruction(snapshot.interviewDifficulty)}`
          : '',
        'Use role rubric only. Never imply that external candidate documents exist.',
      ]
        .filter(Boolean)
        .join('\n\n');
    }

    if (contextMode === 'CV_ONLY') {
      return [
        `Target role: ${session.targetRole}`,
        'Context mode: candidate-profile practice grounded in the provided resume.',
        snapshot?.cv?.title ? `CV title: ${snapshot.cv.title}` : '',
        snapshot?.interviewDifficulty
          ? `Interview difficulty profile:\n${this.formatInterviewDifficultyInstruction(snapshot.interviewDifficulty)}`
          : '',
        'Keep profile context silent and use it only to choose relevant follow-up questions.',
      ]
        .filter(Boolean)
        .join('\n\n');
    }

    return [
      `Target role: ${session.targetRole}`,
      'Context mode: CV/JD match practice.',
      snapshot?.cv?.title ? `CV title: ${snapshot.cv.title}` : '',
      snapshot?.jobDescription?.title
        ? `Job description title: ${snapshot.jobDescription.title}`
        : '',
      snapshot?.cvMatch?.overallScore != null
        ? `CV/JD match score: ${snapshot.cvMatch.overallScore}`
        : '',
      snapshot?.cvMatch?.strengths
        ? `Matched strengths to reference: ${this.limit(JSON.stringify(snapshot.cvMatch.strengths), 800)}`
        : '',
      snapshot?.cvMatch?.weaknesses
        ? `Important gaps to probe: ${this.limit(JSON.stringify(snapshot.cvMatch.weaknesses), 800)}`
        : '',
      snapshot?.interviewDifficulty
        ? `Interview difficulty profile:\n${this.formatInterviewDifficultyInstruction(snapshot.interviewDifficulty)}`
        : '',
      'Do not read the CV/JD context aloud. Use it only to choose relevant follow-up questions.',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  /**
   * New sessions persist a bounded context snapshot so every answer turn and realtime reconnect
   * sees the same CV/JD facts. Legacy sessions fall back to a small identity/role block rather
   * than pretending that a full CV/JD context exists.
   */
  private interviewContextForSession(session: InterviewSessionEntity): string {
    const snapshot = this.asContextSnapshot(session.contextSnapshot);
    if (snapshot?.interviewContext) return snapshot.interviewContext;

    const identity = snapshot?.identity;
    return [
      `Candidate name: ${identity?.candidateName ?? 'not available'}`,
      `Interview role: ${identity?.jobTitle ?? session.targetRole}`,
      identity?.employerName
        ? `Employer explicitly identified by the JD: ${identity.employerName}`
        : 'Employer: not identified in the JD; do not invent one',
      `Context mode: ${snapshot?.contextMode ?? this.contextModeFromSession(session)}`,
      'Legacy session: only the compact context above is available; do not claim unseen CV/JD facts.',
    ].join('\n');
  }

  private resolveInterviewDifficulty(
    cv: CvEntity | null,
    jd: JobDescriptionEntity | null,
    targetRole: string,
  ): InterviewDifficultyProfile {
    const targetRoleLevel = this.levelFromTitle(targetRole);
    if (targetRoleLevel) {
      return {
        level: targetRoleLevel,
        source: 'target role',
        note: 'Matched explicit seniority wording in the requested target role.',
      };
    }

    const jdLevel = this.levelFromTitle([jd?.title, jd?.rawText].filter(Boolean).join('\n'));
    if (jdLevel) {
      return {
        level: jdLevel,
        source: 'job description',
        note: 'Matched explicit seniority wording or years-of-experience signal in the JD.',
      };
    }

    const cvTitleLevel = this.levelFromTitle(
      [cv?.targetRole, cv?.title].filter(Boolean).join('\n'),
    );
    if (cvTitleLevel) {
      return {
        level: cvTitleLevel,
        source: 'candidate CV',
        note: 'Matched explicit seniority wording in the CV title or CV target role.',
      };
    }

    if (cv?.parsedJson) {
      const seniority = deriveCvSeniority(cv.parsedJson);
      if (seniority.confidence !== 'low') {
        return {
          level: seniority.bucket,
          source: 'candidate CV',
          note: `Derived from structured CV experience (${seniority.signals.join(', ')}).`,
        };
      }
    }

    const cvTextLevel = this.levelFromTitle(cv?.parsedText ?? '');
    if (cvTextLevel) {
      return {
        level: cvTextLevel,
        source: 'candidate CV',
        note: 'Matched seniority wording or years-of-experience signal in the CV text.',
      };
    }

    return {
      level: 'junior',
      source: 'default',
      note: 'No explicit seniority signal was found; use a junior-friendly baseline.',
    };
  }

  private resolveSessionInterviewDifficulty(
    session: InterviewSessionEntity,
    context?: string,
  ): InterviewDifficultyProfile {
    const snapshot = this.asContextSnapshot(session.contextSnapshot);
    if (snapshot?.interviewDifficulty) return snapshot.interviewDifficulty;

    const level = this.levelFromTitle([session.targetRole, context].filter(Boolean).join('\n'));
    return level
      ? {
          level,
          source: 'target role',
          note: 'Matched explicit seniority wording in the available interview context.',
        }
      : {
          level: 'junior',
          source: 'default',
          note: 'No explicit seniority signal was found; use a junior-friendly baseline.',
        };
  }

  private levelFromTitle(text: string | null | undefined): InterviewDifficultyLevel | null {
    const value = text?.trim();
    if (!value) return null;

    const explicit = classifySeniority(value);
    if (explicit) return this.levelFromSeniorityLevel(explicit);

    const years = this.extractExperienceYears(value);
    if (years === null) return null;
    if (years >= 7) return 'senior';
    if (years >= 4) return 'mid';
    if (years >= 1) return 'junior';
    return 'fresher';
  }

  private levelFromSeniorityLevel(level: SeniorityLevel): InterviewDifficultyLevel {
    const map: Record<SeniorityLevel, InterviewDifficultyLevel> = {
      INTERN: 'intern',
      FRESHER: 'fresher',
      JUNIOR: 'junior',
      MIDDLE: 'mid',
      SENIOR: 'senior',
      LEAD: 'lead',
    };
    return map[level];
  }

  private extractExperienceYears(text: string): number | null {
    const match =
      text.match(
        /(\d+(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?|nam|năm)\s+(?:of\s+)?(?:experience|kinh\s+nghiem|kinh\s+nghiệm)/i,
      ) ?? text.match(/(?:experience|kinh\s+nghiem|kinh\s+nghiệm)[^\d]{0,24}(\d+(?:\.\d+)?)/i);
    if (!match) return null;

    const years = Number(match[1]);
    return Number.isFinite(years) ? years : null;
  }

  private formatInterviewDifficultyInstruction(profile: InterviewDifficultyProfile): string {
    return [
      `Candidate seniority level: ${profile.level}. Seniority evidence source: ${profile.source}. ${profile.note}`,
      this.difficultyGuidance(profile.level, profile.source === 'default'),
    ].join('\n');
  }

  private difficultyGuidance(level: InterviewDifficultyLevel, isDefault: boolean): string {
    switch (level) {
      case 'intern':
      case 'fresher':
        return 'Difficulty calibration: Start with fundamentals, school/internship/personal projects, basic API/CRUD/debugging, and simple trade-offs. Do not ask senior-level architecture, distributed systems, incident leadership, or broad system design unless the candidate first shows strong evidence.';
      case 'junior':
        return isDefault
          ? 'Difficulty calibration: No explicit seniority signal was found; use a junior-friendly baseline. Start with practical project work, API/CRUD, database basics, debugging, auth/validation, and gradually deepen only when answers are strong.'
          : 'Difficulty calibration: Start with practical project work, API/CRUD, database basics, debugging, auth/validation, and gradually deepen into trade-offs only when answers are strong.';
      case 'mid':
        return 'Difficulty calibration: Ask about module ownership, trade-offs, transaction boundaries, caching, performance, observability, and debugging real production issues. Keep architecture questions scoped to systems the candidate has actually worked on.';
      case 'senior':
        return 'Difficulty calibration: Ask deeper architecture, scalability, cross-team trade-offs, production incidents, mentoring, and technical decision-making questions, while still grounding each question in the available interview context.';
      case 'lead':
        return 'Difficulty calibration: Ask about technical leadership, architecture ownership, prioritization, mentoring, incident response, stakeholder trade-offs, and system-level decisions, while avoiding questions unrelated to the target role.';
      default:
        return 'Difficulty calibration: Use a junior-friendly baseline and increase depth only when the candidate demonstrates stronger experience.';
    }
  }

  private asContextSnapshot(value: unknown): InterviewContextSnapshot | null {
    if (!value || typeof value !== 'object') return null;
    return value as InterviewContext['snapshot'];
  }

  private contextModeFromSession(session: InterviewSessionEntity): InterviewContextMode {
    const snapshot = this.asContextSnapshot(session.contextSnapshot);
    if (
      snapshot?.contextMode === 'ROLE_ONLY' ||
      snapshot?.contextMode === 'CV_ONLY' ||
      snapshot?.contextMode === 'CV_JD_MATCH'
    ) {
      return snapshot.contextMode;
    }
    if (session.cvMatchId) return 'CV_JD_MATCH';
    if (session.cvId) return 'CV_ONLY';
    return 'ROLE_ONLY';
  }

  private async findOwnedSession(
    userId: string,
    sessionId: string,
  ): Promise<InterviewSessionEntity> {
    const session = await this.sessions.findOne({ where: { id: sessionId, userId } });
    if (!session) throw new NotFoundException('Interview session not found');
    return session;
  }

  private assertInProgress(session: InterviewSessionEntity): void {
    if (session.status !== 'IN_PROGRESS') {
      throw new BadRequestException({
        errorCode: ERROR_CODES.VALIDATION_ERROR,
        message: 'Interview session is not in progress',
      });
    }
  }

  /**
   * Self-healing sweep: before a user starts (and pays for) a new session, finalize their own
   * expired sessions through the SAME partial-scoring path as /end — an abandoned
   * session (tab closed, network drop) with >=1 answered turn gets scored and its gap report
   * persisted instead of leaking the paid quota; one with 0 answers is CANCELLED.
   * Never throws: a sweep failure must not block starting the new session.
   *
   * Sweeps COMPLETED-without-a-score too, not just IN_PROGRESS. Three paths mark a session
   * COMPLETED while the score and report are only ever written by `end()`: the engine deciding
   * to finish (`answer`), the time limit firing (`assertNotExpired`), and the legacy end. All
   * three tell the client to call /end — so when the client never does (tab closed, crash), the
   * row is stranded COMPLETED with a null score, hidden from the user's own history by the
   * `overallScore: Not(IsNull())` filter in `list`, and previously unreachable by this sweep.
   *
   * Both arms stay gated on `expiresAt` in the past: while a session can still legitimately be
   * ended by its own client, healing it here would race that request.
   */
  private async sweepStaleSessions(userId: string): Promise<void> {
    try {
      const expired = LessThan(new Date());
      const stale =
        (await this.sessions.find({
          where: [
            { userId, status: 'IN_PROGRESS', expiresAt: expired },
            { userId, status: 'COMPLETED', overallScore: IsNull(), expiresAt: expired },
          ],
        })) ?? [];
      for (const session of stale) {
        try {
          await this.end(userId, { sessionId: session.id });
        } catch (error) {
          this.logger.warn(
            `Failed to finalize stale interview session ${session.id}: ${String(error)}`,
          );
          // Record the failure instead of leaving the row to be retried forever. Without this,
          // `FAILED` is legal in the enum and the CHECK constraint but never written, so a broken
          // session is indistinguishable from one the user walked away from — and, worse, it still
          // matches the predicate above, so EVERY later start re-runs `end()` on it: a fresh
          // coaching LLM call each time, for a row that will keep failing.
          //
          // The guard is `overallScore IS NULL` — the same condition that put the row in this
          // sweep — and NOT the status. Status cannot express it: both arms above arrive here
          // (IN_PROGRESS and COMPLETED-without-a-score), so pinning either one leaves the other
          // looping. Scoring the row is what "healed" means; if `end` got a score written before
          // throwing, the row is healed and this no-ops.
          //
          // The trade-off: one attempt, then terminal. A transient blip now costs a paid session
          // its report, where before it would be retried on the user's next start. That is the
          // right side to err on — a deterministic failure (one answer the model won't parse)
          // otherwise bills a coaching call on every start forever, and the failure was invisible
          // either way. Now it lands in the fail-rate query instead, where we can see it.
          await this.sessions
            .update({ id: session.id, overallScore: IsNull() }, { status: 'FAILED' })
            .catch(() => undefined);
        }
      }
    } catch (error) {
      this.logger.warn(`Stale interview session sweep failed for user ${userId}: ${String(error)}`);
    }
  }

  private async assertNotExpired(session: InterviewSessionEntity): Promise<void> {
    const expiresAt = session.expiresAt;
    if (!expiresAt || Date.now() <= expiresAt.getTime()) return;

    session.status = 'COMPLETED';
    session.endedAt = expiresAt;
    session.durationSeconds = session.maxDurationSeconds;
    await this.sessions.save(session);
    throw new BadRequestException({
      errorCode: ERROR_CODES.INTERVIEW_TIME_LIMIT_REACHED,
      message:
        'Interview session time limit has been reached. End the session to generate feedback.',
    });
  }

  private maxDurationSecondsForPlan(planCode: string | null | undefined): number {
    if (planCode === 'PREMIUM') return PREMIUM_INTERVIEW_SECONDS;
    return PRO_INTERVIEW_SECONDS;
  }

  private turnBudgetForPlan(planCode: string | null | undefined): number {
    return TURN_BUDGET_BY_TIER[planCode === 'PREMIUM' || planCode === 'PRO' ? 'paid' : 'free'];
  }

  private async getTurns(sessionId: string): Promise<InterviewTurnEntity[]> {
    return this.turns.find({ where: { sessionId }, order: { turnOrder: 'ASC' } });
  }

  private hasValidStoredAnswer(turn: InterviewTurnEntity): boolean {
    const answer = this.trimOrNull(turn.userAnswerText);
    if (!answer || this.hasUnsafeLiveTranscript(answer)) return false;
    if (turn.modality !== 'AUDIO') return true;
    return this.hasMeaningfulTranscript(answer, turn.interviewerQuestion);
  }

  private hasMeaningfulTranscript(answer: string, interviewerQuestion: string): boolean {
    if (
      this.normalizeTranscriptForComparison(answer) ===
      this.normalizeTranscriptForComparison(interviewerQuestion)
    ) {
      return false;
    }
    const compactLength = answer.replace(/\s+/g, '').length;
    if (compactLength < 4) return false;
    return this.transcriptTokens(answer).length >= 2;
  }

  private transcriptTokens(value: string): string[] {
    return value.match(/[\p{L}\p{N}+#.]+/gu) ?? [];
  }

  private normalizeTranscriptForComparison(value: string): string {
    return value
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}+#.]+/gu, ' ')
      .trim();
  }

  private hasUnsafeLiveTranscript(text: string): boolean {
    if (CJK_SCRIPT_PATTERN.test(text)) return true;
    return LEGACY_TRANSCRIPTION_PROMPT_PATTERNS.some((pattern) => pattern.test(text));
  }

  private finalizationState(session: InterviewSessionEntity): InterviewFinalizationState | null {
    const root =
      session.interviewState && typeof session.interviewState === 'object'
        ? (session.interviewState as Record<string, unknown>)
        : {};
    const value = root.finalization;
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Record<string, unknown>;
    const status = candidate.status;
    if (status !== 'PENDING' && status !== 'READY' && status !== 'FAILED') {
      return null;
    }
    if (typeof candidate.attemptId !== 'string' || typeof candidate.startedAt !== 'string') {
      return null;
    }
    return candidate as unknown as InterviewFinalizationState;
  }

  private withFinalizationState(
    value: unknown,
    finalization: InterviewFinalizationState,
  ): Record<string, unknown> {
    const root = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    return { ...root, finalization };
  }

  private analysisStatus(session: InterviewSessionEntity): InterviewAnalysisStatus {
    if (session.status === 'CANCELLED') return 'NOT_REQUIRED';
    if (session.status === 'COMPLETED') return 'READY';
    if (session.status === 'FAILED') return 'FAILED';
    const root =
      session.interviewState && typeof session.interviewState === 'object'
        ? (session.interviewState as Record<string, unknown>)
        : {};
    const finalization = root.finalization;
    if (!finalization || typeof finalization !== 'object') return 'NOT_STARTED';
    const status = (finalization as { status?: unknown }).status;
    if (status === 'PENDING') return 'PENDING';
    if (status === 'FAILED') return 'FAILED';
    if (status === 'READY') return 'READY';
    return 'NOT_STARTED';
  }

  private toSessionDto(session: InterviewSessionEntity): InterviewSessionDto {
    return {
      id: session.id,
      cvId: session.cvId,
      cvMatchId: session.cvMatchId,
      jobDescriptionId: session.jobDescriptionId,
      contextMode: this.contextModeFromSession(session),
      targetRole: session.targetRole,
      language: session.language,
      mode: session.mode,
      experienceMode: session.experienceMode ?? 'MOCK',
      interviewType: session.interviewType,
      voice: resolveInterviewVoice(
        session.voice,
        this.config?.get<string>('llm.openai.realtimeVoice'),
      ),
      speechSpeed: this.speechSpeed(session.speechSpeed),
      status: session.status,
      analysisStatus: this.analysisStatus(session),
      totalQuestionsPlanned: session.totalQuestionsPlanned,
      maxDurationSeconds: session.maxDurationSeconds,
      expiresAt: session.expiresAt ? session.expiresAt.toISOString() : null,
      overallScore: this.numberOrNull(session.overallScore),
      semanticScore: this.numberOrNull(session.semanticScore),
      llmScore: this.numberOrNull(session.llmScore),
      communicationScore: this.numberOrNull(session.communicationScore),
      aiFeedback: session.aiFeedback,
      finalScore: session.finalScore,
      gapItems: session.gapItems,
      devPlan: session.devPlan,
      coaching: session.coaching,
      durationSeconds: session.durationSeconds,
      startedAt: this.dateIso(session.startedAt ?? session.createdAt),
      endedAt: session.endedAt ? session.endedAt.toISOString() : null,
      createdAt: this.dateIso(session.createdAt ?? session.startedAt),
      updatedAt: session.updatedAt ? session.updatedAt.toISOString() : null,
    };
  }

  private toTurnDto(turn: InterviewTurnEntity): InterviewTurnDto {
    return {
      id: turn.id,
      sessionId: turn.sessionId,
      turnOrder: turn.turnOrder,
      phase: turn.phase,
      topicPhase: turn.topicPhase,
      modality: turn.modality,
      aiRequestId: turn.aiRequestId,
      interviewerMessage: turn.interviewerMessage,
      interviewerQuestion: turn.interviewerQuestion,
      userAnswerText: turn.userAnswerText,
      userAnswerTranscript: turn.userAnswerTranscript,
      perQuestionScore: this.numberOrNull(turn.perQuestionScore),
      depthSignal: turn.depthSignal,
      signals: turn.signals,
      insight: turn.insight,
      turnTrace: turn.turnTrace ?? null,
      currentThread: turn.currentThread,
      skillCanonical: turn.skillCanonical,
      questionBankItemId: turn.questionBankItemId ?? null,
      questionBankKey: turn.questionBankKey ?? null,
      strengths: turn.strengths,
      improvements: turn.improvements,
      askedAt: this.dateIso(turn.askedAt ?? turn.createdAt),
      answeredAt: turn.answeredAt ? turn.answeredAt.toISOString() : null,
      durationSeconds: turn.durationSeconds,
      responseDelayMs: turn.responseDelayMs ?? null,
      transcriptSegments: turn.transcriptSegments ?? null,
      timeBudgetSeconds: turn.timeBudgetSeconds ?? null,
      questionThreadId: turn.questionThreadId ?? null,
      candidateIntent: turn.candidateIntent as InterviewTurnDto['candidateIntent'],
      assistanceLevel: turn.assistanceLevel ?? 'NONE',
      scoreCap: turn.scoreCap ?? null,
      rawScore: this.numberOrNull(turn.perQuestionScore),
      finalQuestionScore: this.cappedTurnScore(turn),
      skipReason: turn.skipReason ?? null,
    };
  }

  private cappedTurnScore(turn: InterviewTurnEntity): number | null {
    const raw = this.numberOrNull(turn.perQuestionScore);
    return raw === null || turn.scoreCap === null ? raw : Math.min(raw, turn.scoreCap);
  }

  private score(value: number | null | undefined): string | null {
    return value === null || value === undefined ? null : value.toFixed(2);
  }

  private language(value: string | null | undefined): Language {
    return value === 'en' ? 'en' : 'vi';
  }

  private speechSpeed(value: string | number | null | undefined): number {
    const numeric = Number(value ?? DEFAULT_INTERVIEW_SPEECH_SPEED);
    return Number.isFinite(numeric)
      ? Math.round(numeric * 100) / 100
      : DEFAULT_INTERVIEW_SPEECH_SPEED;
  }

  private numberOrNull(value: string | number | null | undefined): number | null {
    return value === null || value === undefined ? null : Number(value);
  }

  private durationSeconds(start: Date | undefined, end: Date): number {
    if (!start) return 0;
    return Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
  }

  private addSeconds(date: Date, seconds: number): Date {
    return new Date(date.getTime() + seconds * 1000);
  }

  private resolveEndedAt(session: InterviewSessionEntity): Date {
    if (session.expiresAt && Date.now() > session.expiresAt.getTime()) return session.expiresAt;
    return new Date();
  }

  private dateIso(value: Date | undefined): string {
    return (value ?? new Date()).toISOString();
  }

  private trimOrNull(value: string | null | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  }

  private limit(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max)}...` : text;
  }
}

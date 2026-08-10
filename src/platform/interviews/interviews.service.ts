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
import { QuestionHistoryItemDto } from '../../modules/interview/dto/answer-interview.dto';
import {
  AgendaTopic,
  buildInterviewAgenda,
  decideTurnWithTrace,
  DepthSignal,
  drillLadderRung,
  DrillLadderRung,
  filterGroundedGaps,
  filterRecognizedConcepts,
  groundInterviewThread,
  InterviewAgenda,
  InterviewPhase as AgendaInterviewPhase,
  InterviewState,
  InterviewTurnTrace,
  isGroundedFollowUp,
  pickDrillAnchor,
  shouldChallengeBeforeAdvance,
  TURN_BUDGET_BY_TIER,
  TurnAction,
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
  isRepeatedInterviewQuestion,
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
  AnswerInterviewResponseDto,
  AnswerPlatformInterviewDto,
  EndPlatformInterviewDto,
  InterviewContextMode,
  InterviewDetailResponseDto,
  InterviewListQueryDto,
  InterviewSessionDto,
  InterviewTurnDto,
  LiveInterviewTurnDto,
  RealtimeClientSecretDto,
  StartInterviewResponseDto,
  StartPlatformInterviewDto,
} from './dto/interview.dto';
import { OpenAiQuestionAudioService, QuestionAudioResult } from './openai-question-audio.service';
import { OpenAiRealtimeTokenService } from './openai-realtime-token.service';
import { InterviewAssessOutput, InterviewChainLlmService } from './interview-chain-llm.service';
import { resolveInterviewVoice } from './interview-voice';

const PRO_INTERVIEW_SECONDS = 10 * 60;
const PREMIUM_INTERVIEW_SECONDS = 15 * 60;
const CLOSING_QUESTION_WINDOW_SECONDS = 90;
const NO_NEW_QUESTION_SECONDS = 25;
const STANDARD_INTERVIEW_HARD_TURN_CAP = 20;
const PREMIUM_INTERVIEW_HARD_TURN_CAP = 30;
const MAX_ANSWER_HISTORY_TURNS = 6;
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

/** compact trace slug for an anchored drill (I-INTEL), e.g. `anchor_redis_cache`. */
const anchorTraceSlug = (anchor: string): string =>
  `anchor_${anchor
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32)}`;

/**
 * I-OWN: rungs where an unmeasured answer earns the metric demand. `application`/`tradeoff` are
 * the "what you did / why you chose it" rungs — the two where a real outcome number is fair to
 * ask for. Other rungs already carry their own ask (ownership, hindsight, failure modes).
 */
const METRIC_DEMAND_RUNGS: ReadonlySet<DrillLadderRung> = new Set<DrillLadderRung>([
  'application',
  'tradeoff',
]);
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

interface AnswerTurnContext {
  current: InterviewTurnEntity | null;
  historyTurns: InterviewTurnEntity[];
}

interface ReviewedLiveTurn {
  turnOrder: number;
  interviewerQuestion: string;
  userAnswerText: string;
  userAnswerTranscript: string;
  durationSeconds: number | null;
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
type InterviewTurnDecision =
  | 'continue_topic'
  | 'advance_topic'
  | 'adaptive_follow_up'
  | 'closing_prompt'
  | 'finish';
type InterviewFinishReason =
  | 'TIME_LIMIT'
  | 'USER_REQUEST'
  | 'SAFETY_CAP'
  | 'AGENDA_COMPLETE'
  | 'QUALITY_GUARD'
  | null;
type InterviewNextQuestionKind = 'opening' | 'follow_up' | 'transition' | 'closing' | null;

interface InterviewDifficultyProfile {
  level: InterviewDifficultyLevel;
  source: InterviewDifficultySource;
  note: string;
}

@Injectable()
export class InterviewsService {
  private readonly logger = new Logger(InterviewsService.name);

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
    private readonly questionAudio?: OpenAiQuestionAudioService,
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
      const language = dto.language ?? 'vi';
      const mode = dto.mode ?? 'HYBRID';
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
      const agenda = this.applyQuestionBankToAgenda(
        buildInterviewAgenda({
          focusAreas,
          seniority: context.snapshot.interviewDifficulty.level,
          turnBudget: this.turnBudgetForPlan(entitlements.planCode),
        }),
        questionBankItems,
        agendaCriteria,
        context.contextMode,
      );
      const interviewState = this.initialInterviewState(agenda);
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
        interviewType,
        voice: resolveInterviewVoice(dto.voice, this.config?.get<string>('llm.openai.ttsVoice')),
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
      firstMessage = buildInterviewOpening(context.identity, language);
      firstQuestion = firstTopic.seed_question;
      let openerAiRequestId: string | null = null;
      if (this.interviewChain) {
        // I-REAL-2: personalize the opener — ground the first question in the candidate's
        // CV/JD topic instead of asking the raw seed. Best-effort: start must NEVER fail
        // because the chain is down; any error falls back to the seed question.
        try {
          const opener = await this.interviewChain.ask(userId, {
            sessionId: session.id,
            turnOrder: 1,
            decision: 'opener',
            language: this.language(language),
            seniorityTarget: firstTopic.seniority_target,
            currentTopic: this.topicForPrompt(firstTopic),
            currentThread: firstTopic.what_to_probe,
            recentQa: [],
            runningNotes: [],
            prevTopicOutcome: '',
            topicPhase: firstTopic.phase,
            interviewContext: context.promptContext,
          });
          if (opener.question) {
            firstQuestion = opener.question;
            openerAiRequestId = opener.aiRequestId;
          }
        } catch (err) {
          this.logger.warn(
            `Opener chain call failed for session ${session.id}; using seed question: ${(err as Error).message}`,
          );
        }
      }
      const firstTurn = this.turns.create({
        sessionId: session.id,
        turnOrder: 1,
        phase: firstTopic.phase,
        topicPhase: firstTopic.phase,
        modality: session.mode === 'TEXT' ? 'TEXT' : 'AUDIO',
        aiRequestId: openerAiRequestId,
        interviewerMessage: firstMessage,
        interviewerQuestion: firstQuestion,
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
          clientSecret: null,
          expiresAt: null,
          reason: 'Realtime setup is temporarily unavailable',
        };
      }

      return {
        ...this.toSessionDto(session),
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

  async answer(
    userId: string,
    dto: AnswerPlatformInterviewDto,
  ): Promise<AnswerInterviewResponseDto> {
    const session = await this.findOwnedSession(userId, dto.sessionId);
    this.assertInProgress(session);
    await this.assertNotExpired(session);
    const answerContext = await this.getAnswerTurnContext(session.id);
    const current = answerContext.current;
    if (!current) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.VALIDATION_ERROR,
        message: 'Interview session has no pending question',
      });
    }
    const userAnswer = this.normalizeSubmittedAnswer(
      dto.userAnswer,
      current.interviewerQuestion,
      dto.modality,
    );

    if (!this.hasNewTurnDependencies(session)) {
      return this.answerLegacy(userId, session, { ...dto, userAnswer }, answerContext, current);
    }

    const agenda = this.asInterviewAgenda(session.agenda);
    const state = this.asInterviewState(session.interviewState);
    const topic = this.findTopic(agenda, state.current_topic_id);
    if (!topic) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.VALIDATION_ERROR,
        message: 'Interview session agenda is out of sync',
      });
    }

    const targetDimensions = topicDimensions(topic.phase);
    const targetDimension = targetDimensions[0] ?? 'communication';
    const rubricDimensions = targetDimensions.length > 0 ? targetDimensions : [targetDimension];
    const recentQa = this.questionHistory(answerContext.historyTurns, current, userAnswer);
    const interviewContext = this.interviewContextForSession(session);
    const signals = analyzeAnswerSignals({
      answer: userAnswer,
      question: current.interviewerQuestion,
      jd_terms: this.topicTerms(topic),
      language: this.language(session.language),
    });

    // Persist the candidate's answer before any LLM work. If structured output is truncated,
    // the finalizer can still recover this turn through ensureTurnAnalysis instead of losing it.
    const answeredAt = new Date();
    current.userAnswerText = userAnswer;
    current.userAnswerTranscript = this.trimOrNull(dto.userTranscript)?.normalize('NFC') ?? null;
    current.modality = dto.modality ?? current.modality;
    current.answeredAt = answeredAt;
    current.durationSeconds = dto.durationSeconds ?? null;
    current.responseDelayMs = dto.responseDelayMs ?? null;
    current.transcriptSegments = dto.transcriptSegments ?? null;
    await this.turns.save(current);

    const assessmentPromise = this.interviewChain!.assess(userId, {
      sessionId: session.id,
      turnOrder: current.turnOrder,
      language: this.language(session.language),
      seniorityTarget: topic.seniority_target,
      currentTopic: this.topicForPrompt(topic),
      targetDimensions: rubricDimensions,
      targetDimension,
      currentThread: state.current_thread || topic.what_to_probe,
      drillDepth: state.drill_depth,
      recentQa,
      interviewContext,
    });
    const insightPromise = this.answerInsight!.judge(
      {
        answer: userAnswer,
        question: current.interviewerQuestion,
        target_dimension: targetDimension,
        language: this.language(session.language),
        signals,
      },
      userId,
    );
    const [assessment, insight] = await Promise.all([assessmentPromise, insightPromise]);
    const recognized = filterRecognizedConcepts(assessment.recognizedConcepts, userAnswer);
    // I-CONSIST: reconcile LLM self-contradictions BEFORE anything consumes them — the depth
    // guard first (a "deep" too-short answer downgrades to adequate, so it neither out-weighs
    // real answers nor triggers push_harder), then the score caps. Decision, persistence, and
    // aggregation only ever see the reconciled values.
    const depthGuard = reconcileDepthSignal({
      depth_signal: assessment.depthSignal,
      is_too_short: signals.flags.is_too_short,
    });
    const scoreAssessments = calibrateInterviewAnswerScores({
      dimensions: rubricDimensions,
      criteria: assessment.criterionScores ?? [],
      legacyScore:
        assessment.scoreSource === 'criterion_rubric' || assessment.scoreSource === 'unscored'
          ? null
          : assessment.score,
      depthSignal: depthGuard.depth_signal,
      offTopic: insight.off_topic,
      claimStatus: assessment.claimStatus,
    });
    const scoreAssessment = scoreAssessments[targetDimension] ?? null;
    const perQuestionScore = averageCalibratedScores(scoreAssessments);
    const guardReasons = [
      ...depthGuard.reasons,
      ...new Set(
        Object.values(scoreAssessments).flatMap((item) =>
          item.reasons.filter((reason) => reason !== 'legacy_score_fallback'),
        ),
      ),
    ];

    const groundedThread = groundInterviewThread({
      proposed_thread: assessment.currentThread,
      previous_thread: state.current_thread,
      answer: userAnswer,
      question: current.interviewerQuestion,
      topic: [topic.display_name, topic.skill_canonical].filter(Boolean).join(' '),
    });
    const groundedAssessment: InterviewAssessOutput = {
      ...assessment,
      currentThread: groundedThread.thread,
    };
    const nextState = this.advanceStateBeforeDecision(state, groundedAssessment);
    const secondsRemaining = this.secondsRemaining(session);
    const hardCap = this.hardTurnCapForSession(session);
    let action: TurnAction;
    let askTopic: AgendaTopic = topic;
    let updatedState = nextState;
    let ask = { aiMessage: '', question: '', aiRequestId: null as string | null };
    let turnDecision: InterviewTurnDecision;
    let finishReason: InterviewFinishReason = null;
    let nextQuestionKind: InterviewNextQuestionKind;
    let nextTurnOrder: number | null = null;
    let turnTrace: InterviewTurnTrace;
    let drillAnchor: string | null = null;
    let demandExample = false;
    let demandMetric = false;
    const wrapTrace = (reason: string): InterviewTurnTrace => ({
      action: 'wrap',
      phase: topic.phase,
      topic_id: topic.id,
      reasons: [reason],
      // follow-ups asked on this topic — same meaning as decideTurnWithTrace's `depth`.
      depth: state.drill_depth,
      remaining_turn_budget: Math.max(0, hardCap - nextState.turns_used),
      confidence: 'high',
    });

    if (nextState.turns_used >= hardCap) {
      turnDecision = 'finish';
      finishReason = 'SAFETY_CAP';
      nextQuestionKind = null;
      turnTrace = wrapTrace('safety_cap');
    } else if (this.isClosingTurn(current)) {
      turnDecision = 'finish';
      finishReason = 'TIME_LIMIT';
      nextQuestionKind = null;
      turnTrace = wrapTrace('time_limit');
    } else if (this.shouldFinishForTime(secondsRemaining)) {
      turnDecision = 'finish';
      finishReason = 'TIME_LIMIT';
      nextQuestionKind = null;
      turnTrace = wrapTrace('time_limit');
    } else {
      const decided = decideTurnWithTrace({
        signal: depthGuard.depth_signal,
        // follow-ups already asked on this topic — the PRE-increment count, which is what every
        // rule in decide() is written against (advanceStateBeforeDecision has already counted the
        // answer we are deciding on, and that count is not a follow-up).
        drill_depth: state.drill_depth,
        drill_budget: topic.drill_budget,
        turns_used: nextState.turns_used,
        turn_budget: hardCap + 2,
        evasive_streak: nextState.evasive_streak,
        seniority_target: topic.seniority_target,
        phase: topic.phase,
        topic_id: topic.id,
      });
      const rawAction = decided.action;
      turnTrace = decided.trace;
      const challengeBeforeAdvance =
        rawAction === 'advance' &&
        shouldChallengeBeforeAdvance({
          claim_status: assessment.claimStatus,
          off_topic: insight.off_topic,
          drill_depth: state.drill_depth,
          drill_budget: topic.drill_budget,
        });
      const effectiveAction: TurnAction = challengeBeforeAdvance ? 'drill' : rawAction;
      if (challengeBeforeAdvance) {
        turnTrace = {
          ...turnTrace,
          action: 'drill',
          confidence: 'medium',
          reasons: [...turnTrace.reasons, 'challenge_before_topic_advance'],
        };
      }
      if (!groundedThread.accepted && assessment.currentThread.trim()) {
        turnTrace = {
          ...turnTrace,
          confidence: 'low',
          reasons: [...turnTrace.reasons, 'thread_grounding_fallback'],
        };
      }
      const nextTopic = effectiveAction === 'advance' ? this.nextTopic(agenda, topic.id) : null;

      if (this.shouldAskClosingQuestion(secondsRemaining)) {
        action = 'wrap';
        askTopic = this.closingTopic(session, topic);
        updatedState = {
          ...nextState,
          current_phase: 'WRAP',
          current_thread: askTopic.what_to_probe,
        };
        turnDecision = 'closing_prompt';
        nextQuestionKind = 'closing';
        turnTrace = { ...turnTrace, action: 'wrap', reasons: ['time_low_closing_question'] };
      } else {
        const exhaustedTopics = effectiveAction === 'advance' && !nextTopic;
        if (rawAction === 'wrap') {
          // `wrap` is a terminal decision. The old implementation converted it into another
          // drill, which made the candidate answer one more question even after the engine had
          // explicitly decided to close. A real interviewer closes instead of silently moving
          // the goalposts.
          action = 'wrap';
          askTopic = topic;
          updatedState = {
            ...nextState,
            current_phase: 'WRAP',
            current_thread: 'interview wrap-up',
          };
          turnDecision = 'finish';
          finishReason = 'SAFETY_CAP';
          nextQuestionKind = null;
          turnTrace = {
            ...turnTrace,
            action: 'wrap',
            reasons: [...turnTrace.reasons, 'wrap_requested_terminal'],
          };
        } else if (exhaustedTopics) {
          // `advance` with no next topic means the deterministic agenda is complete. Do not
          // manufacture an adaptive follow-up on the last topic; that was the source of the
          // repeated-question loop reported in production smoke tests.
          action = 'advance';
          askTopic = topic;
          updatedState = {
            ...nextState,
            current_phase: 'WRAP',
            current_thread: 'agenda complete',
            covered_topic_ids: [...new Set([...nextState.covered_topic_ids, topic.id])],
          };
          turnDecision = 'finish';
          finishReason = 'AGENDA_COMPLETE';
          nextQuestionKind = null;
          turnTrace = {
            ...turnTrace,
            action: 'wrap',
            reasons: [...turnTrace.reasons, 'agenda_complete_terminal'],
          };
        } else {
          action = effectiveAction;
          askTopic = action === 'advance' && nextTopic ? nextTopic : topic;
          updatedState = this.applyTurnDecision(nextState, agenda, topic, askTopic, action);
          turnDecision = action === 'advance' ? 'advance_topic' : 'continue_topic';
          nextQuestionKind = action === 'advance' ? 'transition' : 'follow_up';
        }
      }

      if (turnDecision !== 'finish') {
        // I-REAL-2: which ladder rung the next drill/push question must target — code-owned,
        // derived from the follow-up count on this topic (first follow-up = application, then
        // tradeoff; early-career gets reflection in between).
        // I-OWN: a collective answer ("we…" with never an "I") overrides the depth rung — a real
        // interviewer stops climbing and asks whose call it actually was. Asked at most ONCE per
        // session (see InterviewState.ownership_probed): repeating it every turn would badger the
        // plural-speaking candidate and stall the ladder. SCENARIO is exempt: the incident chain
        // owns its own follow-up shape.
        const collectiveAnswer =
          signals.ownership.collective_answer &&
          askTopic.phase !== 'SCENARIO' &&
          !updatedState.ownership_probed;
        const ladderRung =
          action === 'drill' || action === 'push_harder'
            ? drillLadderRung(state.drill_depth, askTopic.seniority_target, { collectiveAnswer })
            : null;
        if (ladderRung) {
          turnTrace = { ...turnTrace, reasons: [...turnTrace.reasons, `ladder_${ladderRung}`] };
        }
        if (ladderRung === 'decision_ownership') {
          updatedState = { ...updatedState, ownership_probed: true };
          turnTrace = {
            ...turnTrace,
            reasons: [...turnTrace.reasons, 'demand_individual_contribution'],
          };
        }

        // I-INTEL: anchor the drill/push on a concept from THIS answer (never re-drill one);
        // a drill with nothing concrete to anchor on demands one real example instead.
        // SCENARIO is exempt — the incident chain owns the follow-up shape there.
        if ((action === 'drill' || action === 'push_harder') && askTopic.phase !== 'SCENARIO') {
          drillAnchor = pickDrillAnchor({
            answer: userAnswer,
            recognized_concepts: recognized,
            jd_terms: this.topicTerms(askTopic),
            probed_anchors: updatedState.probed_anchors ?? [],
          }).anchor;
          if (drillAnchor) {
            updatedState = {
              ...updatedState,
              probed_anchors: [...(updatedState.probed_anchors ?? []), drillAnchor],
            };
            turnTrace = {
              ...turnTrace,
              reasons: [...turnTrace.reasons, anchorTraceSlug(drillAnchor)],
            };
          } else if (ladderRung !== 'decision_ownership' && signals.flags.no_concrete_example) {
            demandExample = true;
            turnTrace = {
              ...turnTrace,
              reasons: [...turnTrace.reasons, 'demand_concrete_example'],
            };
          }
          // I-OWN: they described the work on a how/why rung but never measured it — the follow-up
          // asks for the number. One demand per question: ownership and example-demand both win.
          // Two things must be true before it is a FAIR ask, and the instruction asserts both:
          //  - the answer actually described work — a too-short answer owes detail, not a metric
          //    (the same is_too_short the I-CONSIST depth guard already trusts);
          //  - the topic is technical — a STAR failure story on BEHAVIORAL has no before/after
          //    number to give, so demanding one is a category error, not a probe.
          if (
            !demandExample &&
            ladderRung &&
            METRIC_DEMAND_RUNGS.has(ladderRung) &&
            askTopic.phase !== 'BEHAVIORAL'
          ) {
            demandMetric = !signals.is_quantified && !signals.flags.is_too_short;
            if (demandMetric) {
              turnTrace = {
                ...turnTrace,
                reasons: [...turnTrace.reasons, 'demand_measurable_outcome'],
              };
            }
          }
        }

        nextTurnOrder = await this.nextTurnOrder(session.id, current.turnOrder);
        const previousQuestions = recentQa.map((item) => item.question);
        ask = await this.interviewChain!.ask(userId, {
          sessionId: session.id,
          turnOrder: nextTurnOrder,
          decision: action,
          language: this.language(session.language),
          seniorityTarget: askTopic.seniority_target,
          currentTopic: this.topicForPrompt(askTopic),
          currentThread: updatedState.current_thread,
          recentQa,
          runningNotes: updatedState.running_notes,
          prevTopicOutcome: this.prevTopicOutcome(
            topic,
            groundedAssessment,
            depthGuard.depth_signal,
          ),
          ladderRung,
          topicPhase: askTopic.phase,
          drillAnchor,
          demandExample,
          demandMetric,
          interviewContext,
          avoidQuestions: previousQuestions,
        });
        if (ask.question && isRepeatedInterviewQuestion(ask.question, previousQuestions)) {
          // A repetition is a quality failure, not a reason to expose the candidate to another
          // identical turn. Give the model one grounded retry with the offending wording included
          // in the avoid-list, then use a code-owned fallback if it still ignores the guard.
          turnTrace = {
            ...turnTrace,
            confidence: 'low',
            reasons: [...turnTrace.reasons, 'question_repetition_retry'],
          };
          let retry: Awaited<ReturnType<InterviewChainLlmService['ask']>> | null = null;
          try {
            retry = await this.interviewChain!.ask(userId, {
              sessionId: session.id,
              turnOrder: nextTurnOrder,
              decision: action,
              language: this.language(session.language),
              seniorityTarget: askTopic.seniority_target,
              currentTopic: this.topicForPrompt(askTopic),
              currentThread: updatedState.current_thread,
              recentQa,
              runningNotes: updatedState.running_notes,
              prevTopicOutcome: this.prevTopicOutcome(
                topic,
                groundedAssessment,
                depthGuard.depth_signal,
              ),
              ladderRung,
              topicPhase: askTopic.phase,
              drillAnchor,
              demandExample,
              demandMetric,
              interviewContext,
              avoidQuestions: [...previousQuestions, ask.question],
            });
          } catch (error) {
            this.logger.warn(
              `Question repetition retry failed for session ${session.id}; using deterministic fallback: ${(error as Error).message}`,
            );
          }
          if (retry?.question && !isRepeatedInterviewQuestion(retry.question, previousQuestions)) {
            ask = retry;
          } else {
            ask = { ...(retry ?? ask), question: '' };
          }
        }
        if (!ask.question) {
          // the chain gave no question → the seed question is asked instead (see nextQuestion
          // below). Label it honestly: low-confidence fallback, never a silent degrade.
          turnTrace = {
            ...turnTrace,
            confidence: 'low',
            reasons: [...turnTrace.reasons, 'fallback_seed_question'],
          };
        } else if (action === 'drill' || action === 'push_harder') {
          // I-REAL-2 anti-template guard: a follow-up that shares no content term with the
          // candidate's answer/thread/topic is template-shaped — flag it (observability only).
          const grounded = isGroundedFollowUp(ask.question, [
            userAnswer,
            updatedState.current_thread,
            askTopic.display_name,
            ...this.topicTerms(askTopic),
          ]);
          if (!grounded) {
            turnTrace = {
              ...turnTrace,
              action: 'drill',
              confidence: 'low',
              reasons: [...turnTrace.reasons, 'generic_follow_up_replaced'],
            };
            ask = {
              ...ask,
              aiMessage:
                this.language(session.language) === 'vi'
                  ? 'Cảm ơn bạn. Mình sẽ hỏi sâu hơn đúng vào phần bạn vừa nói.'
                  : 'Thank you. I will stay with that point and ask one deeper question.',
              question: this.groundedFollowUpFallback(
                this.language(session.language),
                askTopic,
                updatedState.current_thread,
                ladderRung,
              ),
            };
          }
        }
      }
    }

    if (guardReasons.length > 0) {
      turnTrace = { ...turnTrace, reasons: [...turnTrace.reasons, ...guardReasons] };
    }

    current.turnTrace = {
      ...turnTrace,
      score_assessment: scoreAssessment,
      score_assessments: scoreAssessments,
    } as InterviewTurnTrace;
    current.userAnswerText = userAnswer;
    current.userAnswerTranscript = this.trimOrNull(dto.userTranscript)?.normalize('NFC') ?? null;
    current.modality = dto.modality ?? current.modality;
    current.aiRequestId = assessment.aiRequestId;
    current.perQuestionScore = this.score(perQuestionScore);
    current.strengths = recognized;
    // Grounded like `recognized` above: a gap can't be required to appear in the answer
    // (it names what's missing), so anchor it to the topic universe instead — the asked
    // question + the agenda topic's JD terms — dropping invented off-topic weaknesses.
    current.improvements = filterGroundedGaps(assessment.gapsRevealed, [
      current.interviewerQuestion,
      ...this.topicTerms(topic),
      topic.what_to_probe,
      ...(topic.expected_signals ?? []),
    ]);
    current.topicPhase = topic.phase;
    current.depthSignal = depthGuard.depth_signal;
    current.signals = signals;
    current.insight = insight;
    current.currentThread = groundedAssessment.currentThread || updatedState.current_thread;
    current.skillCanonical = topic.skill_canonical;
    current.answeredAt = answeredAt;
    await this.turns.save(current);

    let nextTurn: InterviewTurnEntity | null = null;
    if (turnDecision !== 'finish') {
      const previousQuestions = recentQa.map((item) => item.question);
      const nextQuestion = this.uniqueNextQuestion(
        ask.question || askTopic.seed_question,
        askTopic,
        this.language(session.language),
        previousQuestions,
      );
      if (!nextQuestion) {
        // Never persist a repeated question as a fallback. A graceful, explicit finish is safer
        // than pretending the interview progressed while asking the same thing again.
        turnDecision = 'finish';
        finishReason = 'QUALITY_GUARD';
        nextQuestionKind = null;
        turnTrace = {
          ...turnTrace,
          action: 'wrap',
          confidence: 'low',
          reasons: [...turnTrace.reasons, 'question_repetition_unrecoverable'],
        };
        current.turnTrace = {
          ...turnTrace,
          score_assessment: scoreAssessment,
          score_assessments: scoreAssessments,
        } as InterviewTurnTrace;
        await this.turns.save(current);
      } else {
        if (nextQuestion !== ask.question) {
          turnTrace = {
            ...turnTrace,
            confidence: 'low',
            reasons: [...turnTrace.reasons, 'unique_question_fallback'],
          };
          current.turnTrace = {
            ...turnTrace,
            score_assessment: scoreAssessment,
            score_assessments: scoreAssessments,
          } as InterviewTurnTrace;
          await this.turns.save(current);
        }
        ask = { ...ask, question: nextQuestion };
        const tracking = this.questionBankTrackingForTopic(askTopic, nextQuestion);
        nextTurn = await this.turns.save(
          this.turns.create({
            sessionId: session.id,
            turnOrder: nextTurnOrder ?? current.turnOrder + 1,
            phase: askTopic.phase,
            topicPhase: askTopic.phase,
            modality: session.mode === 'TEXT' ? 'TEXT' : 'AUDIO',
            aiRequestId: ask.aiRequestId,
            interviewerMessage: ask.aiMessage,
            interviewerQuestion: nextQuestion,
            currentThread: updatedState.current_thread,
            skillCanonical: askTopic.skill_canonical,
            questionBankItemId: tracking.questionBankItemId,
            questionBankKey: tracking.questionBankKey,
            // `nextQuestionKind` already carries the only distinction the budget needs — a fresh
            // question (opening/transition) vs a drill into one already asked (follow_up/closing).
            timeBudgetSeconds: answerTimeBudgetSeconds(nextQuestionKind),
          }),
        );
      }
    }

    session.interviewState = updatedState;
    if (turnDecision === 'finish') {
      session.status = 'COMPLETED';
      session.endedAt = new Date();
      session.durationSeconds = this.durationSeconds(session.startedAt, session.endedAt);
    }
    await this.sessions.save(session);

    return {
      session: this.toSessionDto(session),
      answeredTurn: this.toTurnDto(current),
      nextTurn: nextTurn ? this.toTurnDto(nextTurn) : null,
      aiMessage: ask.aiMessage,
      nextQuestion: nextTurn?.interviewerQuestion ?? null,
      finished: turnDecision === 'finish',
      turnDecision,
      finishReason,
      nextQuestionKind,
      turnTrace,
    };
  }

  async end(userId: string, dto: EndPlatformInterviewDto): Promise<InterviewDetailResponseDto> {
    const session = await this.findOwnedSession(userId, dto.sessionId);
    let turns = await this.getTurns(session.id);
    if (session.mode === 'VOICE' && Array.isArray(dto.liveTurns)) {
      turns = await this.syncReviewedLiveTurns(session, dto.liveTurns, turns);
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

    if (!this.hasNewEndDependencies()) {
      return this.endLegacy(userId, session, answeredTurns, turns, endedAt);
    }

    const analyses = await this.ensureTurnAnalyses(userId, session, answeredTurns);
    const difficulty = this.resolveSessionInterviewDifficulty(session);
    // Wave I-SCORE: same aggregation as before, plus per-dimension explanations with evidence
    // quotes (masked inside the module) — score and explanations come from ONE pass.
    const { score, explanations } = explainInterviewScore({
      answers: analyses
        .filter(
          (item) =>
            item.depthSignal !== null &&
            (item.score !== null ||
              Object.values(item.scoreAssessments).some((assessment) => assessment.score !== null)),
        )
        .map((item) => ({
          topic_phase: item.topicPhase,
          score:
            item.score ??
            (Object.values(item.scoreAssessments).find((assessment) => assessment.score !== null)
              ?.score as number),
          depth_signal: item.depthSignal as DepthSignal,
          score_source: item.scoreAssessment?.source,
          dimension_scores: Object.fromEntries(
            Object.entries(item.scoreAssessments)
              .filter(([, assessment]) => assessment.score !== null)
              .map(([dimension, assessment]) => [dimension, assessment.score]),
          ) as Partial<Record<Dimension, number>>,
          dimension_score_sources: Object.fromEntries(
            Object.entries(item.scoreAssessments)
              .filter(([, assessment]) => assessment.score !== null)
              .map(([dimension, assessment]) => [dimension, assessment.source]),
          ) as Partial<Record<Dimension, 'criterion_rubric' | 'legacy_llm' | 'unscored'>>,
          evidence_excerpt: item.turn.userAnswerText ?? undefined,
          linked_question_id: item.turn.id,
        })),
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
    const saved = await this.sessions.save(session);

    return {
      ...this.toSessionDto(saved),
      turns: turns.map((turn) => this.toTurnDto(turn)),
    };
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
      this.compactRealtimeContext(session),
    );
    await this.sessions.save(session);
    return realtime;
  }

  async createQuestionAudio(userId: string, sessionId: string): Promise<QuestionAudioResult> {
    const session = await this.findOwnedSession(userId, sessionId);
    this.assertInProgress(session);
    await this.assertNotExpired(session);

    const current = await this.turns.findOne({
      where: { sessionId: session.id, userAnswerText: IsNull() },
      order: { turnOrder: 'ASC' },
    });
    if (!current) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.VALIDATION_ERROR,
        message: 'Interview session has no pending question to read',
      });
    }

    if (!this.questionAudio) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.VALIDATION_ERROR,
        message: 'Question audio service is not configured',
      });
    }

    return this.questionAudio.createQuestionAudio(
      userId,
      session,
      this.interviewerTurnSpeech(current.interviewerMessage, current.interviewerQuestion),
    );
  }

  private hasNewTurnDependencies(session: InterviewSessionEntity): boolean {
    return Boolean(
      this.interviewChain && this.answerInsight && session.agenda && session.interviewState,
    );
  }

  private hasNewEndDependencies(): boolean {
    return Boolean(this.interviewChain && this.answerInsight && this.coachingService);
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

  private asInterviewAgenda(value: unknown): InterviewAgenda {
    if (!value || typeof value !== 'object' || !Array.isArray((value as InterviewAgenda).topics)) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.VALIDATION_ERROR,
        message: 'Interview session agenda is missing',
      });
    }
    return value as InterviewAgenda;
  }

  private asInterviewState(value: unknown): InterviewState {
    if (!value || typeof value !== 'object') {
      throw new BadRequestException({
        errorCode: ERROR_CODES.VALIDATION_ERROR,
        message: 'Interview session state is missing',
      });
    }
    return value as InterviewState;
  }

  private findTopic(agenda: InterviewAgenda, topicId: string): AgendaTopic | null {
    return agenda.topics.find((topic) => topic.id === topicId) ?? null;
  }

  private nextTopic(agenda: InterviewAgenda, topicId: string): AgendaTopic | null {
    const index = agenda.topics.findIndex((topic) => topic.id === topicId);
    if (index < 0) return null;
    return agenda.topics.slice(index + 1).find((topic) => topic.phase !== 'WRAP') ?? null;
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
    const enrich = (topic: AgendaTopic): AgendaTopic => {
      const selected = selectInterviewQuestion(questionBankItems, {
        language: criteria.language,
        targetRole: criteria.targetRole,
        interviewType: criteria.interviewType,
        phase: topic.phase,
        skillCanonical: topic.skill_canonical,
        focusType: topic.focus_type ?? null,
        seniority: criteria.seniority,
      });
      if (!selected) return topic;
      if (contextMode === 'ROLE_ONLY' && this.hasContextSpecificQuestion(selected.questionText)) {
        return topic;
      }
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

  private questionBankTrackingForTopic(
    topic: AgendaTopic,
    question: string,
  ): { questionBankItemId: string | null; questionBankKey: string | null } {
    if (question !== topic.seed_question) {
      return { questionBankItemId: null, questionBankKey: null };
    }
    return {
      questionBankItemId: topic.question_bank_item_id ?? null,
      questionBankKey: topic.question_bank_key ?? null,
    };
  }

  private primaryDimension(phase: AgendaInterviewPhase): Dimension {
    return topicDimensions(phase)[0] ?? 'communication';
  }

  private topicTerms(topic: AgendaTopic): string[] {
    return [topic.display_name, topic.skill_canonical].filter((value): value is string =>
      Boolean(value),
    );
  }

  private topicForPrompt(topic: AgendaTopic): Record<string, unknown> {
    return {
      id: topic.id,
      phase: topic.phase,
      skill_canonical: topic.skill_canonical,
      display_name: topic.display_name,
      seniority_target: topic.seniority_target,
      drill_budget: topic.drill_budget,
      what_to_probe: topic.what_to_probe,
      seed_question: topic.seed_question,
      question_bank_key: topic.question_bank_key ?? null,
      expected_signals: topic.expected_signals ?? [],
      rubric_dimensions: topic.rubric_dimensions ?? [],
    };
  }

  private advanceStateBeforeDecision(
    state: InterviewState,
    assessment: InterviewAssessOutput,
  ): InterviewState {
    const note = assessment.note.trim();
    return {
      ...state,
      drill_depth: state.drill_depth + 1,
      turns_used: state.turns_used + 1,
      evasive_streak: assessment.depthSignal === 'evasive' ? state.evasive_streak + 1 : 0,
      current_thread: assessment.currentThread || state.current_thread,
      running_notes: note ? [...state.running_notes, note].slice(-5) : state.running_notes,
    };
  }

  private applyTurnDecision(
    state: InterviewState,
    agenda: InterviewAgenda,
    currentTopic: AgendaTopic,
    askTopic: AgendaTopic,
    action: TurnAction,
  ): InterviewState {
    if (action !== 'advance') {
      return {
        ...state,
        current_phase: currentTopic.phase,
        current_topic_id: currentTopic.id,
      };
    }

    return {
      ...state,
      current_phase: askTopic.phase,
      current_topic_id: askTopic.id,
      current_thread: askTopic.what_to_probe,
      drill_depth: 0,
      evasive_streak: 0,
      covered_topic_ids: [...new Set([...state.covered_topic_ids, currentTopic.id])],
      uncovered_topic_ids: agenda.uncovered.map((topic) => topic.id),
    };
  }

  private uniqueNextQuestion(
    candidate: string,
    topic: AgendaTopic,
    language: Language,
    previousQuestions: string[],
  ): string | null {
    const role = topic.display_name;
    const fallbackQuestions =
      language === 'vi'
        ? [
            topic.seed_question,
            `Bạn hãy nêu một quyết định cụ thể bạn đã đưa ra khi làm việc với ${role}.`,
            `Trong phần ${role}, bạn đã kiểm tra kết quả bằng cách nào?`,
            `Nếu làm lại phần ${role}, bạn sẽ thay đổi điều gì?`,
          ]
        : [
            topic.seed_question,
            `What is one concrete decision you made while working with ${role}?`,
            `How did you verify the result in the ${role} work?`,
            `What would you change if you did the ${role} work again?`,
          ];
    return (
      [candidate, ...fallbackQuestions]
        .map((question) => question.trim())
        .find(
          (question) => question && !isRepeatedInterviewQuestion(question, previousQuestions),
        ) ?? null
    );
  }

  private groundedFollowUpFallback(
    language: Language,
    topic: AgendaTopic,
    thread: string,
    rung: DrillLadderRung | null,
  ): string {
    const label = (thread.trim() || topic.display_name).replace(/\s+/g, ' ').slice(0, 120);
    if (language === 'vi') {
      if (rung === 'tradeoff') {
        return `Với "${label}", bạn đã chọn cách đó thay vì phương án nào, và trade-off là gì?`;
      }
      if (rung === 'edge_failure') {
        return `Với "${label}", cách xử lý đó có thể thất bại trong trường hợp nào và bạn theo dõi điều gì?`;
      }
      return `Quay lại "${label}", bạn sẽ kiểm tra điều gì trước, theo thứ tự nào, và vì sao?`;
    }
    if (rung === 'tradeoff') {
      return `For "${label}", what alternative did you reject, and what trade-off made you choose this approach?`;
    }
    if (rung === 'edge_failure') {
      return `For "${label}", where could this approach fail, and what would you monitor?`;
    }
    return `Returning to "${label}", what would you check first, in what order, and why?`;
  }

  private prevTopicOutcome(
    topic: AgendaTopic,
    assessment: InterviewAssessOutput,
    effectiveDepth?: string,
  ): string {
    return [
      topic.display_name,
      effectiveDepth ?? assessment.depthSignal,
      assessment.claimStatus !== 'ok' ? assessment.claimStatus : '',
      assessment.note,
    ]
      .filter(Boolean)
      .join(' | ');
  }

  private async answerLegacy(
    userId: string,
    session: InterviewSessionEntity,
    dto: AnswerPlatformInterviewDto,
    answerContext: AnswerTurnContext,
    current: InterviewTurnEntity,
  ): Promise<AnswerInterviewResponseDto> {
    const aiAnswer = await this.interviewAi.answer(userId, {
      session_id: session.id,
      question_history: this.questionHistory(answerContext.historyTurns, current, dto.userAnswer),
      current_user_answer: maskPii(dto.userAnswer),
      current_question_order: current.turnOrder,
    });

    current.userAnswerText = dto.userAnswer;
    current.userAnswerTranscript = this.trimOrNull(dto.userTranscript)?.normalize('NFC') ?? null;
    current.modality = dto.modality ?? current.modality;
    current.perQuestionScore = this.score(aiAnswer.per_question_score);
    current.strengths = aiAnswer.per_question_strengths;
    current.improvements = aiAnswer.per_question_improvements;
    current.answeredAt = new Date();
    current.durationSeconds = dto.durationSeconds ?? null;
    await this.turns.save(current);

    let nextTurn: InterviewTurnEntity | null = null;
    if (aiAnswer.next_question) {
      nextTurn = await this.turns.save(
        this.turns.create({
          sessionId: session.id,
          turnOrder: await this.nextTurnOrder(session.id, current.turnOrder),
          phase: aiAnswer.phase,
          modality: session.mode === 'TEXT' ? 'TEXT' : 'AUDIO',
          aiRequestId: aiAnswer.ai_request_id,
          interviewerMessage: aiAnswer.ai_message,
          interviewerQuestion: aiAnswer.next_question,
        }),
      );
    }

    if (aiAnswer.finished || !aiAnswer.next_question) {
      session.status = 'COMPLETED';
      session.endedAt = new Date();
      session.durationSeconds = this.durationSeconds(session.startedAt, session.endedAt);
      await this.sessions.save(session);
    }

    return {
      session: this.toSessionDto(session),
      answeredTurn: this.toTurnDto(current),
      nextTurn: nextTurn ? this.toTurnDto(nextTurn) : null,
      aiMessage: aiAnswer.ai_message,
      nextQuestion: aiAnswer.next_question,
      finished: aiAnswer.finished,
    };
  }

  private async endLegacy(
    userId: string,
    session: InterviewSessionEntity,
    answeredTurns: InterviewTurnEntity[],
    turns: InterviewTurnEntity[],
    endedAt: Date,
  ): Promise<InterviewDetailResponseDto> {
    const scoring = await this.interviewAi.end(userId, {
      session_id: session.id,
      all_questions_answers: answeredTurns.map((turn) => ({
        order: turn.turnOrder,
        question: turn.interviewerQuestion,
        answer: turn.userAnswerText ?? '',
      })),
      duration_seconds: this.durationSeconds(session.startedAt, endedAt),
      scoring_template_code: 'interview_scoring_v1',
      probed_skills: await this.resolveProbedSkills(userId, session),
    });
    const parsed = scoring.parsed_response;

    session.status = 'COMPLETED';
    session.endedAt = endedAt;
    session.durationSeconds = this.durationSeconds(session.startedAt, endedAt);
    session.finalAiRequestId = scoring.ai_request_id;
    session.overallScore = this.score(parsed.overall_score);
    session.semanticScore = this.score(parsed.semantic_score);
    session.llmScore = this.score(parsed.llm_score);
    session.communicationScore = this.score(parsed.communication_score);
    session.finalScore = {
      overall: parsed.overall_score,
      overall_band: 'legacy',
      dimensions: [],
      role_family: session.targetRole,
      scored_answers: answeredTurns.length,
      score_basis: 'legacy_fallback',
      scoring_note: 'This legacy interview path uses an explicit model score fallback.',
    };
    session.aiFeedback = parsed.ai_feedback;
    const saved = await this.sessions.save(session);

    return {
      ...this.toSessionDto(saved),
      turns: turns.map((turn) => this.toTurnDto(turn)),
    };
  }

  private async ensureTurnAnalyses(
    userId: string,
    session: InterviewSessionEntity,
    turns: InterviewTurnEntity[],
  ): Promise<FinalizedTurnAnalysis[]> {
    const out: FinalizedTurnAnalysis[] = [];
    for (const turn of turns) {
      out.push(await this.ensureTurnAnalysis(userId, session, turn));
    }
    return out;
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

  private async resolveProbedSkills(
    userId: string,
    session: InterviewSessionEntity,
  ): Promise<string> {
    if (!session.cvMatchId || !this.cvMatches) return '';
    const lang = session.language === 'en' ? 'en' : 'vi';
    try {
      const focusAreas = await this.cvMatches.getInterviewFocusAreas(
        userId,
        session.cvMatchId,
        lang,
      );
      return focusAreas
        .map((focus) => focus.skill_canonical)
        .filter(Boolean)
        .join(', ');
    } catch {
      return '';
    }
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
        'Interview context: role-only generic practice. No CV, resume, job description, JD, match report, or gap report was provided.',
        `Interview difficulty profile:\n${this.formatInterviewDifficultyInstruction(interviewDifficulty)}`,
        'Interview rule: ask one question at a time, use only role rubric and role-relevant project/practice examples, and do not mention CV, resume, JD, job description, match score, or gap evidence.',
      ].join('\n\n');
    }

    if (contextMode === 'CV_ONLY') {
      return [
        `Interview identity:\n${identityLines}`,
        `Target role: ${targetRole}`,
        'Interview context: CV-only practice. A CV was provided, but no JD or CV/JD match report was provided.',
        `Interview difficulty profile:\n${this.formatInterviewDifficultyInstruction(interviewDifficulty)}`,
        cv?.parsedText ? `Candidate CV excerpt:\n${this.limit(cv.parsedText, 4000)}` : '',
        'Interview rule: ask one question at a time, ground questions in CV skills/projects when available, and do not claim there is a JD, job requirement, match report, or gap report.',
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
    const templateCode =
      session.mode === 'VOICE' ? 'interview_realtime_voice_v1' : 'interview_realtime_hybrid_v1';
    return this.prompts.render(templateCode, {
      context: context ?? '',
      context_block: context ? `Context:\n${context}` : '',
      difficulty_instruction: difficultyInstruction,
      interview_type: session.interviewType,
      language: session.language,
      language_instruction: languageInstruction,
      target_role: session.targetRole,
    });
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
        'Context mode: role-only generic practice. No CV, resume, job description, JD, match report, or gap report was provided.',
        snapshot?.interviewDifficulty
          ? `Interview difficulty profile:\n${this.formatInterviewDifficultyInstruction(snapshot.interviewDifficulty)}`
          : '',
        'Use role rubric only. Do not mention CV, resume, JD, job description, match score, or gap evidence.',
      ]
        .filter(Boolean)
        .join('\n\n');
    }

    if (contextMode === 'CV_ONLY') {
      return [
        `Target role: ${session.targetRole}`,
        'Context mode: CV-only practice. A CV was provided, but no JD or match report was provided.',
        snapshot?.cv?.title ? `CV title: ${snapshot.cv.title}` : '',
        snapshot?.interviewDifficulty
          ? `Interview difficulty profile:\n${this.formatInterviewDifficultyInstruction(snapshot.interviewDifficulty)}`
          : '',
        'Do not read the CV context aloud. Use it only to choose relevant follow-up questions. Do not mention a JD or gap report.',
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

  private hardTurnCapForSession(session: InterviewSessionEntity): number {
    return (session.maxDurationSeconds ?? PRO_INTERVIEW_SECONDS) >= PREMIUM_INTERVIEW_SECONDS
      ? PREMIUM_INTERVIEW_HARD_TURN_CAP
      : STANDARD_INTERVIEW_HARD_TURN_CAP;
  }

  private secondsRemaining(session: InterviewSessionEntity): number | null {
    if (!session.expiresAt) return null;
    return Math.max(0, Math.ceil((session.expiresAt.getTime() - Date.now()) / 1000));
  }

  private shouldFinishForTime(secondsRemaining: number | null): boolean {
    return secondsRemaining !== null && secondsRemaining <= NO_NEW_QUESTION_SECONDS;
  }

  private shouldAskClosingQuestion(secondsRemaining: number | null): boolean {
    return (
      secondsRemaining !== null &&
      secondsRemaining > NO_NEW_QUESTION_SECONDS &&
      secondsRemaining <= CLOSING_QUESTION_WINDOW_SECONDS
    );
  }

  private isClosingTurn(turn: InterviewTurnEntity): boolean {
    return turn.phase === 'WRAP' || turn.topicPhase === 'WRAP';
  }

  private closingTopic(session: InterviewSessionEntity, currentTopic: AgendaTopic): AgendaTopic {
    const role = session.targetRole || currentTopic.display_name;
    const seedQuestion =
      this.language(session.language) === 'vi'
        ? `Mình còn ít thời gian, nên đây là câu cuối: có dự án hoặc năng lực nào liên quan đến ${role} bạn muốn bổ sung ngắn gọn không?`
        : `We are short on time, so one final question: is there any ${role}-related strength or project you want to add briefly?`;
    return {
      id: 'closing-timebox',
      phase: 'WRAP',
      skill_canonical: null,
      display_name: 'Time-boxed closing',
      source: 'fixed',
      priority: 0,
      seniority_target: currentTopic.seniority_target,
      drill_budget: 1,
      what_to_probe: 'time-boxed closing; one brief final evidence opportunity',
      seed_question: seedQuestion,
    };
  }

  private async getTurns(sessionId: string): Promise<InterviewTurnEntity[]> {
    return this.turns.find({ where: { sessionId }, order: { turnOrder: 'ASC' } });
  }

  private async getAnswerTurnContext(sessionId: string): Promise<AnswerTurnContext> {
    const current = await this.turns.findOne({
      where: { sessionId, userAnswerText: IsNull() },
      order: { turnOrder: 'ASC' },
    });
    if (!current) return { current: null, historyTurns: [] };

    const previousTurns = await this.turns.find({
      where: { sessionId, userAnswerText: Not(IsNull()) },
      order: { turnOrder: 'DESC' },
      take: MAX_ANSWER_HISTORY_TURNS - 1,
    });

    return {
      current,
      historyTurns: [...previousTurns].reverse().concat(current),
    };
  }

  private async nextTurnOrder(sessionId: string, currentTurnOrder: number): Promise<number> {
    const latest = await this.turns.findOne({
      where: { sessionId },
      order: { turnOrder: 'DESC' },
    });
    return Math.max(latest?.turnOrder ?? 0, currentTurnOrder) + 1;
  }

  private questionHistory(
    turns: InterviewTurnEntity[],
    current: InterviewTurnEntity,
    currentAnswer: string,
  ): QuestionHistoryItemDto[] {
    return turns
      .filter((turn) => turn.userAnswerText || turn.id === current.id)
      .map((turn) => ({
        order: turn.turnOrder,
        question: maskPii(turn.interviewerQuestion),
        answer: maskPii(turn.id === current.id ? currentAnswer : (turn.userAnswerText ?? '')),
      }));
  }

  private startPromptCode(type: string): string {
    return type === 'HR' ? 'interview_screening_v1' : 'interview_technical_v1';
  }

  private defaultQuestionCount(type: string): number {
    return type === 'HR' ? 5 : 7;
  }

  private async syncReviewedLiveTurns(
    session: InterviewSessionEntity,
    liveTurns: LiveInterviewTurnDto[],
    existingTurns: InterviewTurnEntity[],
  ): Promise<InterviewTurnEntity[]> {
    const existingByOrder = new Map(existingTurns.map((turn) => [turn.turnOrder, turn]));
    const savedTurns: InterviewTurnEntity[] = [];

    for (const reviewed of liveTurns) {
      const normalized = this.normalizeReviewedLiveTurn(reviewed);
      if (!normalized) continue;

      const entity =
        existingByOrder.get(normalized.turnOrder) ??
        this.turns.create({
          sessionId: session.id,
          turnOrder: normalized.turnOrder,
        });

      entity.sessionId = session.id;
      entity.turnOrder = normalized.turnOrder;
      entity.phase = null;
      entity.modality = 'AUDIO';
      entity.aiRequestId = null;
      entity.interviewerMessage = null;
      entity.interviewerQuestion = normalized.interviewerQuestion;
      entity.userAnswerText = normalized.userAnswerText;
      entity.userAnswerTranscript = normalized.userAnswerTranscript;
      entity.perQuestionScore = null;
      entity.questionBankItemId = null;
      entity.questionBankKey = null;
      entity.strengths = null;
      entity.improvements = null;
      entity.answeredAt = new Date();
      entity.durationSeconds = normalized.durationSeconds;

      savedTurns.push(await this.turns.save(entity));
    }

    return savedTurns.sort((a, b) => a.turnOrder - b.turnOrder);
  }

  private normalizeReviewedLiveTurn(turn: LiveInterviewTurnDto): ReviewedLiveTurn | null {
    const interviewerQuestion = this.trimOrNull(turn.interviewerQuestion);
    const userAnswerText =
      this.trimOrNull(turn.userAnswerText) ?? this.trimOrNull(turn.userAnswerTranscript);
    const userAnswerTranscript = this.trimOrNull(turn.userAnswerTranscript) ?? userAnswerText;

    if (!interviewerQuestion || !userAnswerText || !userAnswerTranscript) return null;
    if (
      this.hasUnsafeLiveTranscript(interviewerQuestion) ||
      this.hasUnsafeLiveTranscript(userAnswerText) ||
      this.hasUnsafeLiveTranscript(userAnswerTranscript)
    ) {
      return null;
    }

    return {
      turnOrder: turn.turnOrder,
      interviewerQuestion,
      userAnswerText,
      userAnswerTranscript,
      durationSeconds: turn.durationSeconds ?? null,
    };
  }

  private normalizeSubmittedAnswer(
    value: string,
    interviewerQuestion: string,
    modality: 'TEXT' | 'AUDIO' | undefined,
  ): string {
    const normalized = this.trimOrNull(value)?.normalize('NFC') ?? null;
    if (!normalized) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.VALIDATION_ERROR,
        message: 'Interview answer is required',
      });
    }
    if (this.hasUnsafeLiveTranscript(normalized)) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.VALIDATION_ERROR,
        message: 'Interview answer transcript is invalid. Please answer again.',
      });
    }
    if (modality === 'AUDIO' && !this.hasMeaningfulTranscript(normalized, interviewerQuestion)) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.VALIDATION_ERROR,
        message: 'Interview answer transcript is too short or unclear. Please answer again.',
      });
    }
    return normalized;
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
      interviewType: session.interviewType,
      voice: resolveInterviewVoice(session.voice, this.config?.get<string>('llm.openai.ttsVoice')),
      speechSpeed: this.speechSpeed(session.speechSpeed),
      status: session.status,
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
    };
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

  private interviewerTurnSpeech(
    message: string | null | undefined,
    question: string | null | undefined,
  ): string {
    return [this.trimOrNull(message), this.trimOrNull(question)].filter(Boolean).join('\n\n');
  }

  private limit(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max)}...` : text;
  }
}

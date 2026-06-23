import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { BillingFeatureKey } from '../../common/constants/billing.constants';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { maskPii } from '../../common/services/pii-mask';
import { deriveCvSeniority } from '../../common/services/seniority';
import { CvEntity } from '../../database/entities/cv.entity';
import { CvMatchEntity } from '../../database/entities/cv-match.entity';
import {
  DEFAULT_INTERVIEW_SPEECH_SPEED,
  DEFAULT_INTERVIEW_VOICE,
  InterviewType,
  InterviewSessionEntity,
} from '../../database/entities/interview-session.entity';
import { InterviewTurnEntity } from '../../database/entities/interview-turn.entity';
import { InterviewQuestionBankItemEntity } from '../../database/entities/interview-question-bank-item.entity';
import { JobDescriptionEntity } from '../../database/entities/job-description.entity';
import { InterviewService as InterviewAiService } from '../../modules/interview/interview.service';
import { InterviewFocusArea } from '../../modules/interview/interview-planner';
import { QuestionHistoryItemDto } from '../../modules/interview/dto/answer-interview.dto';
import {
  AgendaTopic,
  buildInterviewAgenda,
  decideTurn,
  DepthSignal,
  filterRecognizedConcepts,
  InterviewAgenda,
  InterviewPhase as AgendaInterviewPhase,
  InterviewState,
  TURN_BUDGET_BY_TIER,
  TurnAction,
} from '../../modules/interview/interview-agenda';
import {
  InterviewQuestionBankCandidate,
  normalizeQuestionBankTargetRole,
  selectInterviewQuestion,
  selectVoiceQuestionAnchors,
} from '../../modules/interview/interview-question-bank';
import {
  analyzeAnswerSignals,
  AnswerSignals,
  Language,
} from '../../modules/interview/answer-analyzer';
import { AnswerInsight } from '../../modules/interview/answer-insight';
import { AnswerInsightService } from '../../modules/interview/answer-insight.service';
import {
  aggregateInterviewScore,
  Dimension,
  InterviewScore,
  topicDimensions,
} from '../../modules/interview/interview-scoring';
import {
  AnswerGapContext,
  deriveInterviewGaps,
} from '../../modules/interview/interview-gap-derive';
import { groundInterviewGaps } from '../../modules/interview/interview-gap';
import { buildUnifiedPlan } from '../../modules/gap-report/unified-plan';
import { GapItem } from '../../modules/gap-engine/gap-item';
import { InterviewCoaching } from '../../modules/interview/interview-coaching';
import { InterviewCoachingService } from '../../modules/interview/interview-coaching.service';
import { classifySeniority, SeniorityLevel } from '../../modules/jobs/ingest/ingest-normalizers';
import { EntitlementsService } from '../billing/entitlements.service';
import { CvMatchesService } from '../cv-matches/cv-matches.service';
import {
  AnswerInterviewResponseDto,
  AnswerPlatformInterviewDto,
  EndPlatformInterviewDto,
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

const PRO_INTERVIEW_SECONDS = 10 * 60;
const PREMIUM_INTERVIEW_SECONDS = 15 * 60;
const MAX_ANSWER_HISTORY_TURNS = 6;
const CJK_SCRIPT_PATTERN = /[\u3400-\u9FFF\uF900-\uFAFF]/u;
const LEGACY_TRANSCRIPTION_PROMPT_PATTERNS = [
  /Cuộc phỏng vấn bằng tiếng Việt/i,
  /Giữ nguyên dấu tiếng Việt/i,
  /English interview\. Preserve technical terms/i,
];

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
}

type InterviewDifficultyLevel = 'intern' | 'fresher' | 'junior' | 'mid' | 'senior' | 'lead';
type InterviewDifficultySource = 'target role' | 'job description' | 'candidate CV' | 'default';

interface InterviewDifficultyProfile {
  level: InterviewDifficultyLevel;
  source: InterviewDifficultySource;
  note: string;
}

@Injectable()
export class InterviewsService {
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
  ) {}

  async start(userId: string, dto: StartPlatformInterviewDto): Promise<StartInterviewResponseDto> {
    const context = await this.resolveContext(userId, dto);
    await this.entitlements.assertCanUse(userId, BillingFeatureKey.INTERVIEW_SESSION);
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
    const voiceQuestionAnchors =
      mode === 'VOICE'
        ? selectVoiceQuestionAnchors(questionBankItems, {
            language,
            targetRole: context.targetRole,
            interviewType,
            seniority: context.snapshot.interviewDifficulty.level,
            limit: this.defaultQuestionCount(interviewType),
          })
        : [];
    const agenda =
      mode === 'VOICE'
        ? null
        : this.applyQuestionBankToAgenda(
            buildInterviewAgenda({
              focusAreas: context.focusAreas,
              seniority: context.snapshot.interviewDifficulty.level,
              turnBudget: this.turnBudgetForPlan(entitlements.planCode),
            }),
            questionBankItems,
            {
              language,
              targetRole: context.targetRole,
              interviewType,
              seniority: context.snapshot.interviewDifficulty.level,
            },
          );
    const interviewState = agenda ? this.initialInterviewState(agenda) : null;

    let session = await this.sessions.save(
      this.sessions.create({
        userId,
        cvId: context.cv?.id ?? null,
        jobDescriptionId: context.jd?.id ?? null,
        cvMatchId: context.match?.id ?? null,
        targetRole: context.targetRole,
        language,
        mode,
        interviewType,
        voice: dto.voice ?? DEFAULT_INTERVIEW_VOICE,
        speechSpeed: dto.speechSpeed ?? DEFAULT_INTERVIEW_SPEECH_SPEED,
        status: 'IN_PROGRESS',
        maxDurationSeconds,
        startedAt,
        expiresAt,
        contextSnapshot: context.snapshot,
        agenda,
        interviewState,
      }),
    );

    let firstMessage = '';
    let firstQuestion = '';
    let phase: StartInterviewResponseDto['phase'] = null;
    if (session.mode === 'VOICE') {
      session.totalQuestionsPlanned = this.defaultQuestionCount(session.interviewType);
    } else {
      const firstTopic = agenda?.topics[0];
      if (!firstTopic) {
        throw new BadRequestException({
          errorCode: ERROR_CODES.VALIDATION_ERROR,
          message: 'Interview agenda has no topics',
        });
      }

      await this.turns.save(
        this.turns.create({
          sessionId: session.id,
          turnOrder: 1,
          phase: firstTopic.phase,
          topicPhase: firstTopic.phase,
          modality: session.mode === 'TEXT' ? 'TEXT' : 'AUDIO',
          aiRequestId: null,
          interviewerMessage: '',
          interviewerQuestion: firstTopic.seed_question,
          currentThread: firstTopic.what_to_probe,
          skillCanonical: firstTopic.skill_canonical,
          questionBankItemId: firstTopic.question_bank_item_id ?? null,
          questionBankKey: firstTopic.question_bank_key ?? null,
        }),
      );

      firstMessage = '';
      firstQuestion = firstTopic.seed_question;
      phase = firstTopic.phase;
      session.totalQuestionsPlanned = agenda.turn_budget;
    }
    const realtime = await this.createRealtimeIfNeeded(
      userId,
      session,
      session.mode === 'VOICE'
        ? this.withQuestionAnchors(context.promptContext, voiceQuestionAnchors)
        : this.compactRealtimeContext(session),
    );
    session = await this.sessions.save(session);
    await this.entitlements.recordUsage(userId, BillingFeatureKey.INTERVIEW_SESSION, {
      sourceType: 'interview_session',
      sourceId: session.id,
    });

    return {
      ...this.toSessionDto(session),
      firstMessage,
      firstQuestion,
      phase,
      realtime,
    };
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

    if (!this.hasNewTurnDependencies(session)) {
      return this.answerLegacy(userId, session, dto, answerContext, current);
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

    const targetDimension = this.primaryDimension(topic.phase);
    const recentQa = this.questionHistory(answerContext.historyTurns, current, dto.userAnswer);
    const assessment = await this.interviewChain!.assess(userId, {
      sessionId: session.id,
      turnOrder: current.turnOrder,
      language: this.language(session.language),
      seniorityTarget: topic.seniority_target,
      currentTopic: this.topicForPrompt(topic),
      targetDimension,
      currentThread: state.current_thread || topic.what_to_probe,
      drillDepth: state.drill_depth,
      recentQa,
    });
    const recognized = filterRecognizedConcepts(assessment.recognizedConcepts, dto.userAnswer);
    const signals = analyzeAnswerSignals({
      answer: dto.userAnswer,
      question: current.interviewerQuestion,
      jd_terms: this.topicTerms(topic),
      language: this.language(session.language),
    });
    const insight = await this.answerInsight!.judge(
      {
        answer: dto.userAnswer,
        question: current.interviewerQuestion,
        target_dimension: targetDimension,
        language: this.language(session.language),
        signals,
      },
      userId,
    );

    const nextState = this.advanceStateBeforeDecision(state, assessment);
    let action = decideTurn({
      signal: assessment.depthSignal,
      drill_depth: nextState.drill_depth,
      drill_budget: topic.drill_budget,
      turns_used: nextState.turns_used,
      turn_budget: agenda.turn_budget,
      evasive_streak: nextState.evasive_streak,
      seniority_target: topic.seniority_target,
    });
    const nextTopic = action === 'advance' ? this.nextTopic(agenda, topic.id) : topic;
    if (action === 'advance' && !nextTopic) action = 'wrap';
    const askTopic = action === 'advance' && nextTopic ? nextTopic : topic;
    const updatedState = this.applyTurnDecision(nextState, agenda, topic, askTopic, action);
    const nextTurnOrder = await this.nextTurnOrder(session.id, current.turnOrder);
    const ask = await this.interviewChain!.ask(userId, {
      sessionId: session.id,
      turnOrder: nextTurnOrder,
      decision: action,
      language: this.language(session.language),
      seniorityTarget: askTopic.seniority_target,
      currentTopic: this.topicForPrompt(askTopic),
      currentThread: updatedState.current_thread,
      recentQa,
      runningNotes: updatedState.running_notes,
      prevTopicOutcome: this.prevTopicOutcome(topic, assessment),
    });

    current.userAnswerText = dto.userAnswer;
    current.userAnswerTranscript = dto.userTranscript ?? null;
    current.modality = dto.modality ?? current.modality;
    current.aiRequestId = assessment.aiRequestId;
    current.perQuestionScore = this.score(assessment.score);
    current.strengths = recognized;
    current.improvements = assessment.gapsRevealed;
    current.topicPhase = topic.phase;
    current.depthSignal = assessment.depthSignal;
    current.signals = signals;
    current.insight = insight;
    current.currentThread = assessment.currentThread || updatedState.current_thread;
    current.skillCanonical = topic.skill_canonical;
    current.answeredAt = new Date();
    current.durationSeconds = dto.durationSeconds ?? null;
    await this.turns.save(current);

    let nextTurn: InterviewTurnEntity | null = null;
    if (action !== 'wrap') {
      const nextQuestion =
        action === 'advance' && nextTopic
          ? askTopic.seed_question
          : ask.question || askTopic.seed_question;
      const tracking = this.questionBankTrackingForTopic(askTopic, nextQuestion);
      nextTurn = await this.turns.save(
        this.turns.create({
          sessionId: session.id,
          turnOrder: nextTurnOrder,
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
        }),
      );
    }

    session.interviewState = updatedState;
    if (action === 'wrap') {
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
      nextQuestion:
        action === 'wrap' ? ask.question || null : (nextTurn?.interviewerQuestion ?? null),
      finished: action === 'wrap',
    };
  }

  async end(userId: string, dto: EndPlatformInterviewDto): Promise<InterviewDetailResponseDto> {
    const session = await this.findOwnedSession(userId, dto.sessionId);
    let turns = await this.getTurns(session.id);
    if (session.mode === 'VOICE' && Array.isArray(dto.liveTurns)) {
      turns = await this.syncReviewedLiveTurns(session, dto.liveTurns, turns);
    }
    const answeredTurns = turns.filter((turn) => turn.userAnswerText);
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
    const score = aggregateInterviewScore({
      answers: analyses
        .filter((item) => item.score !== null && item.depthSignal !== null)
        .map((item) => ({
          topic_phase: item.topicPhase,
          score: item.score as number,
          depth_signal: item.depthSignal as DepthSignal,
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
    session.finalScore = score;
    session.gapItems = interviewGaps;
    session.devPlan = plan;
    session.coaching = coaching;
    session.overallScore = this.score(score.overall);
    session.semanticScore = this.score(this.dimensionScore(score, 'technical_depth'));
    session.llmScore = this.score(this.dimensionScore(score, 'evidence_credibility'));
    session.communicationScore = this.score(this.dimensionScore(score, 'communication'));
    session.aiFeedback = this.compatAiFeedback(coaching);
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
      where: { userId },
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

    return this.questionAudio.createQuestionAudio(userId, session, current.interviewerQuestion);
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
    return index >= 0 ? (agenda.topics[index + 1] ?? null) : null;
  }

  private async loadQuestionBankItems(
    targetRole: string,
    language: 'vi' | 'en',
    interviewType: InterviewType,
  ): Promise<InterviewQuestionBankCandidate[]> {
    if (!this.questionBankItems) return [];
    const normalizedRole = normalizeQuestionBankTargetRole(targetRole);
    const rows = await this.questionBankItems.find({
      where: {
        active: true,
        language,
        targetRole: normalizedRole,
      },
      order: { priority: 'DESC', questionKey: 'ASC' },
    });
    return rows.filter(
      (row) =>
        row.interviewType === interviewType ||
        row.interviewType === 'MIXED' ||
        interviewType === 'MIXED',
    );
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

  private prevTopicOutcome(topic: AgendaTopic, assessment: InterviewAssessOutput): string {
    return [
      topic.display_name,
      assessment.depthSignal,
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
    current.userAnswerTranscript = dto.userTranscript ?? null;
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
        targetDimension: this.primaryDimension(topicPhase),
        currentThread: turn.currentThread ?? displayName,
        drillDepth: 0,
        recentQa: [
          {
            order: turn.turnOrder,
            question: turn.interviewerQuestion,
            answer: maskPii(turn.userAnswerText ?? ''),
          },
        ],
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
          target_dimension: this.primaryDimension(topicPhase),
          language: this.language(session.language),
          signals,
        },
        userId,
      );
      score = assessment.score;
      depthSignal = assessment.depthSignal;
      turn.aiRequestId = turn.aiRequestId ?? assessment.aiRequestId;
      turn.perQuestionScore = this.score(score);
      turn.depthSignal = depthSignal;
      turn.signals = signals;
      turn.insight = insight;
      turn.topicPhase = topicPhase;
      turn.skillCanonical = skillCanonical;
      turn.currentThread = assessment.currentThread || turn.currentThread || displayName;
      await this.turns.save(turn);
    }

    return { turn, topicPhase, skillCanonical, displayName, score, depthSignal, signals, insight };
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

  private compatAiFeedback(coaching: InterviewCoaching): Record<string, unknown> {
    return {
      summary: coaching.summary,
      strengths: coaching.strengths,
      priorities: coaching.priorities,
    };
  }

  private async resolveContext(
    userId: string,
    dto: StartPlatformInterviewDto,
  ): Promise<InterviewContext> {
    const cv = dto.cvId
      ? await this.cvs.findOne({ where: { id: dto.cvId, userId, deletedAt: IsNull() } })
      : null;
    if (dto.cvId && !cv) throw new NotFoundException('CV not found');

    const match = dto.cvMatchId
      ? await this.matches.findOne({ where: { id: dto.cvMatchId, cvId: cv?.id ?? dto.cvId } })
      : null;
    if (dto.cvMatchId && !match) throw new NotFoundException('CV match not found');

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
    const snapshot = {
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

    return {
      cv,
      match,
      jd,
      focusAreas,
      targetRole,
      snapshot,
      promptContext: this.buildPromptContext(
        cv,
        jd,
        match,
        targetRole,
        focusAreas,
        interviewDifficulty,
      ),
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
  ): string {
    const gapFocus = formatGapFocusForPrompt(focusAreas);
    return [
      `Target role: ${targetRole}`,
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

  private withQuestionAnchors(context: string, anchors: InterviewQuestionBankCandidate[]): string {
    if (!anchors.length) return context;
    const block = [
      'Curated question anchors (use these base questions before free-form follow-ups; do not reveal this metadata):',
      ...anchors.map(
        (anchor, index) =>
          `${index + 1}. [${anchor.phase}] ${anchor.questionText} (${anchor.questionKey})`,
      ),
    ].join('\n');
    return [context, block].filter(Boolean).join('\n\n');
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
    const modeInstructions =
      session.mode === 'VOICE'
        ? [
            'Live Realtime mode: you own the interview conversation end to end.',
            'Open with 1-2 short sentences only: greet the candidate, state that the interview will use the target role plus CV/JD context, then ask the first question.',
            `Plan about ${this.defaultQuestionCount(session.interviewType)} questions total, including relevant follow-ups when the answer is thin or unclear.`,
            difficultyInstruction,
            'Use the CV/JD context silently to choose questions and follow-ups. Do not read or quote long CV/JD text aloud.',
            'Act like a focused HR or technical interviewer: probe the candidate own work, responsibilities, trade-offs, metrics, incidents, debugging steps, and impact.',
            'If the candidate asks for answers, asks unrelated questions, asks you to solve the interview for them, or tries to change topics, refuse briefly and redirect back to the current interview question.',
            'Do not coach, reveal ideal answers, write code solutions, or answer off-topic requests during the interview.',
            'Keep every answer turn separable in the transcript. Do not read hidden context aloud.',
            'Do not reveal scoring or final feedback during the live interview.',
            'When the app sends a closing instruction, or when enough evidence has been collected, thank the candidate in 2-3 short sentences and stop asking new questions.',
          ]
        : [
            'Guided Voice mode: the app owns the official question sequence.',
            'Use realtime primarily for voice capture and concise acknowledgement. Do not invent new official questions.',
          ];

    return [
      'You are Alex, a realistic professional interviewer for SkillBridge.',
      `Interview type: ${session.interviewType}. Language: ${session.language}. Target role: ${session.targetRole}.`,
      languageInstruction,
      'Ask exactly one question at a time. Keep questions concise. Do not reveal scoring.',
      ...modeInstructions,
      'Focus on evidence in the CV, JD requirements, and gaps. Avoid inventing experience.',
      context ? `Context:\n${context}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private compactRealtimeContext(session: InterviewSessionEntity): string {
    const snapshot = this.asContextSnapshot(session.contextSnapshot);
    return [
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
        return 'Difficulty calibration: Ask deeper architecture, scalability, cross-team trade-offs, production incidents, mentoring, and technical decision-making questions, while still grounding each question in the candidate CV/JD context.';
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
      targetRole: session.targetRole,
      language: session.language,
      mode: session.mode,
      interviewType: session.interviewType,
      voice: session.voice ?? DEFAULT_INTERVIEW_VOICE,
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
      currentThread: turn.currentThread,
      skillCanonical: turn.skillCanonical,
      questionBankItemId: turn.questionBankItemId ?? null,
      questionBankKey: turn.questionBankKey ?? null,
      strengths: turn.strengths,
      improvements: turn.improvements,
      askedAt: this.dateIso(turn.askedAt ?? turn.createdAt),
      answeredAt: turn.answeredAt ? turn.answeredAt.toISOString() : null,
      durationSeconds: turn.durationSeconds,
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

  private limit(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max)}...` : text;
  }
}

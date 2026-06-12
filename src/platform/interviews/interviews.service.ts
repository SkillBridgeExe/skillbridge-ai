import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { BillingFeatureKey } from '../../common/constants/billing.constants';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { CvEntity } from '../../database/entities/cv.entity';
import { CvMatchEntity } from '../../database/entities/cv-match.entity';
import { InterviewSessionEntity } from '../../database/entities/interview-session.entity';
import { InterviewTurnEntity } from '../../database/entities/interview-turn.entity';
import { JobDescriptionEntity } from '../../database/entities/job-description.entity';
import { InterviewService as InterviewAiService } from '../../modules/interview/interview.service';
import { QuestionHistoryItemDto } from '../../modules/interview/dto/answer-interview.dto';
import { EntitlementsService } from '../billing/entitlements.service';
import {
  AnswerInterviewResponseDto,
  AnswerPlatformInterviewDto,
  EndPlatformInterviewDto,
  InterviewDetailResponseDto,
  InterviewListQueryDto,
  InterviewSessionDto,
  InterviewTurnDto,
  RealtimeClientSecretDto,
  StartInterviewResponseDto,
  StartPlatformInterviewDto,
} from './dto/interview.dto';
import { OpenAiRealtimeTokenService } from './openai-realtime-token.service';

const PRO_INTERVIEW_SECONDS = 10 * 60;
const PREMIUM_INTERVIEW_SECONDS = 15 * 60;
const MAX_ANSWER_HISTORY_TURNS = 6;

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
}

interface InterviewContext {
  cv: CvEntity | null;
  match: CvMatchEntity | null;
  jd: JobDescriptionEntity | null;
  targetRole: string;
  snapshot: InterviewContextSnapshot;
  promptContext: string;
}

interface AnswerTurnContext {
  current: InterviewTurnEntity | null;
  historyTurns: InterviewTurnEntity[];
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
  ) {}

  async start(userId: string, dto: StartPlatformInterviewDto): Promise<StartInterviewResponseDto> {
    const context = await this.resolveContext(userId, dto);
    await this.entitlements.assertCanUse(userId, BillingFeatureKey.INTERVIEW_SESSION);
    const maxDurationSeconds = await this.resolveMaxDurationSeconds(userId);
    const startedAt = new Date();
    const expiresAt = this.addSeconds(startedAt, maxDurationSeconds);

    let session = await this.sessions.save(
      this.sessions.create({
        userId,
        cvId: context.cv?.id ?? null,
        jobDescriptionId: context.jd?.id ?? null,
        cvMatchId: context.match?.id ?? null,
        targetRole: context.targetRole,
        language: dto.language ?? 'vi',
        mode: dto.mode ?? 'HYBRID',
        interviewType: dto.interviewType ?? 'TECHNICAL',
        status: 'IN_PROGRESS',
        maxDurationSeconds,
        startedAt,
        expiresAt,
        contextSnapshot: context.snapshot,
      }),
    );

    const aiStart = await this.interviewAi.start(userId, {
      session_id: session.id,
      interview_type: session.interviewType,
      topic: session.targetRole,
      language: session.language,
      cv_context: context.promptContext,
      prompt_template_code: this.startPromptCode(session.interviewType),
    });

    await this.turns.save(
      this.turns.create({
        sessionId: session.id,
        turnOrder: 1,
        phase: aiStart.phase,
        modality: session.mode === 'TEXT' ? 'TEXT' : 'AUDIO',
        aiRequestId: aiStart.ai_request_id,
        interviewerMessage: aiStart.first_message,
        interviewerQuestion: aiStart.first_question,
      }),
    );

    session.totalQuestionsPlanned = aiStart.total_questions_planned;
    const realtime = await this.createRealtimeIfNeeded(
      userId,
      session,
      this.compactRealtimeContext(session),
    );
    session = await this.sessions.save(session);
    await this.entitlements.recordUsage(userId, BillingFeatureKey.INTERVIEW_SESSION, {
      sourceType: 'interview_session',
      sourceId: session.id,
    });

    return {
      ...this.toSessionDto(session),
      firstMessage: aiStart.first_message,
      firstQuestion: aiStart.first_question,
      phase: aiStart.phase,
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

    const aiAnswer = await this.interviewAi.answer(userId, {
      session_id: session.id,
      question_history: this.questionHistory(answerContext.historyTurns, current, dto.userAnswer),
      current_user_answer: dto.userAnswer,
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

  async end(userId: string, dto: EndPlatformInterviewDto): Promise<InterviewDetailResponseDto> {
    const session = await this.findOwnedSession(userId, dto.sessionId);
    const turns = await this.getTurns(session.id);
    const answeredTurns = turns.filter((turn) => turn.userAnswerText);
    if (answeredTurns.length === 0) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.VALIDATION_ERROR,
        message: 'Interview session has no answers to score',
      });
    }

    const endedAt = this.resolveEndedAt(session);
    const scoring = await this.interviewAi.end(userId, {
      session_id: session.id,
      all_questions_answers: answeredTurns.map((turn) => ({
        order: turn.turnOrder,
        question: turn.interviewerQuestion,
        answer: turn.userAnswerText ?? '',
      })),
      duration_seconds: this.durationSeconds(session.startedAt, endedAt),
      scoring_template_code: 'interview_scoring_v1',
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

  async list(
    userId: string,
    query: InterviewListQueryDto,
  ): Promise<{ items: InterviewSessionDto[]; total: number; page: number; limit: number }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
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
    };

    return {
      cv,
      match,
      jd,
      targetRole,
      snapshot,
      promptContext: this.buildPromptContext(cv, jd, match, targetRole),
    };
  }

  private buildPromptContext(
    cv: CvEntity | null,
    jd: JobDescriptionEntity | null,
    match: CvMatchEntity | null,
    targetRole: string,
  ): string {
    return [
      `Target role: ${targetRole}`,
      jd ? `Job description title: ${jd.title ?? '(untitled)'}` : 'Job description: not provided',
      jd?.rawText ? `Job description excerpt:\n${this.limit(jd.rawText, 3000)}` : '',
      cv?.parsedText ? `Candidate CV excerpt:\n${this.limit(cv.parsedText, 4000)}` : '',
      match?.strengths ? `CV/JD matched strengths:\n${JSON.stringify(match.strengths)}` : '',
      match?.weaknesses ? `CV/JD gaps to probe:\n${JSON.stringify(match.weaknesses)}` : '',
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
    return [
      'You are Alex, a realistic professional interviewer for SkillBridge.',
      `Interview type: ${session.interviewType}. Language: ${session.language}. Target role: ${session.targetRole}.`,
      'Ask exactly one question at a time. Keep questions concise. Do not reveal scoring.',
      'After the candidate answers, acknowledge briefly, then ask the next relevant question.',
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
      'Do not read the CV/JD context aloud. Use it only to choose relevant follow-up questions.',
    ]
      .filter(Boolean)
      .join('\n\n');
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

  private async resolveMaxDurationSeconds(userId: string): Promise<number> {
    const entitlements = await this.entitlements.getCurrentEntitlements(userId);
    if (entitlements.planCode === 'PREMIUM') return PREMIUM_INTERVIEW_SECONDS;
    return PRO_INTERVIEW_SECONDS;
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
        question: turn.interviewerQuestion,
        answer: turn.id === current.id ? currentAnswer : (turn.userAnswerText ?? ''),
      }));
  }

  private startPromptCode(type: string): string {
    return type === 'HR' ? 'interview_screening_v1' : 'interview_technical_v1';
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
      status: session.status,
      totalQuestionsPlanned: session.totalQuestionsPlanned,
      maxDurationSeconds: session.maxDurationSeconds,
      expiresAt: session.expiresAt ? session.expiresAt.toISOString() : null,
      overallScore: this.numberOrNull(session.overallScore),
      semanticScore: this.numberOrNull(session.semanticScore),
      llmScore: this.numberOrNull(session.llmScore),
      communicationScore: this.numberOrNull(session.communicationScore),
      aiFeedback: session.aiFeedback,
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
      modality: turn.modality,
      aiRequestId: turn.aiRequestId,
      interviewerMessage: turn.interviewerMessage,
      interviewerQuestion: turn.interviewerQuestion,
      userAnswerText: turn.userAnswerText,
      userAnswerTranscript: turn.userAnswerTranscript,
      perQuestionScore: this.numberOrNull(turn.perQuestionScore),
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

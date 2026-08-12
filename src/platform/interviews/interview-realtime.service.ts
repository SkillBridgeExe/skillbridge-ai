import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { InterviewRealtimeDirectiveEntity } from '../../database/entities/interview-realtime-directive.entity';
import { InterviewSessionEntity } from '../../database/entities/interview-session.entity';
import { InterviewTurnEntity } from '../../database/entities/interview-turn.entity';
import { analyzeAnswerSignals, type AnswerSignals } from '../../modules/interview/answer-analyzer';
import {
  CommitRealtimeAssistantMessageDto,
  RealtimeInterviewTurnDto,
  RealtimeTurnDirectiveDto,
} from './dto/interview.dto';
import {
  InterviewAssistanceLevel,
  InterviewDirectiveAction,
  InterviewTurnPolicyService,
  RealtimeAnswerSignal,
  RealtimeTurnPolicyState,
} from './interview-turn-policy.service';

interface RealtimeAgendaTopic {
  id: string;
  what_to_probe?: string;
  seed_question?: string;
  phase?: string;
  skill_canonical?: string;
}

interface RealtimeInterviewState extends RealtimeTurnPolicyState {
  topicHistory: string[];
  questionFingerprints: string[];
}

@Injectable()
export class InterviewRealtimeService {
  constructor(
    @InjectRepository(InterviewSessionEntity)
    private readonly sessions: Repository<InterviewSessionEntity>,
    @InjectRepository(InterviewTurnEntity)
    private readonly turns: Repository<InterviewTurnEntity>,
    @InjectRepository(InterviewRealtimeDirectiveEntity)
    private readonly directives: Repository<InterviewRealtimeDirectiveEntity>,
    private readonly policy: InterviewTurnPolicyService,
  ) {}

  async submitTurn(
    userId: string,
    sessionId: string,
    dto: RealtimeInterviewTurnDto,
  ): Promise<RealtimeTurnDirectiveDto> {
    const session = await this.ownedSession(userId, sessionId);
    const existing = await this.directives.findOne({
      where: { sessionId, clientTurnId: dto.clientTurnId },
    });
    if (existing) return this.toDirectiveDto(existing);

    const currentTurn = await this.turns.findOne({
      where: { sessionId, answeredAt: IsNull() },
      order: { turnOrder: 'DESC' },
    });
    if (!currentTurn) throw new BadRequestException('Interview session has no pending question');

    const topics = this.agendaTopics(session.agenda);
    const state = this.realtimeState(session, currentTurn, topics);
    const nextTopic = this.nextTopic(topics, state);
    const language = session.language === 'en' ? 'en' : 'vi';
    const answerAnalysis = analyzeAnswerSignals({
      answer: dto.transcript,
      language,
    });
    const answerSignal = this.effectiveAnswerSignal(dto.intent, dto.answerSignal, answerAnalysis);
    const result = this.policy.decide({
      experienceMode: session.experienceMode ?? 'MOCK',
      intent: dto.intent,
      answerSignal,
      state,
      nextTopicId: nextTopic?.id ?? null,
      nextQuestionThreadId: nextTopic ? crypto.randomUUID() : null,
    });
    const fallbackQuestion = this.fallbackQuestion(
      result.action,
      currentTurn,
      nextTopic,
      language,
      answerAnalysis,
    );
    const entity = this.directives.create({
      sessionId,
      turnId: currentTurn.id,
      clientTurnId: dto.clientTurnId,
      transcript: dto.transcript,
      modality: dto.modality,
      intent: dto.intent,
      answerSignal,
      action: result.action,
      consumesAttempt: result.consumesAttempt,
      topicId: result.state.topicId,
      questionThreadId: result.state.questionThreadId,
      difficultyStep: result.state.difficultyStep,
      assistanceLevel: result.assistanceLevel,
      scoreCap: result.scoreCap,
      threadScore: result.threadScore,
      finished: result.finished,
      questionGoal: fallbackQuestion,
      reasons: result.reasons,
      speechEndedAt: dto.speechEndedAt ? new Date(dto.speechEndedAt) : null,
    });

    let saved: InterviewRealtimeDirectiveEntity;
    try {
      saved = await this.directives.save(entity);
    } catch (error) {
      if (!this.isUniqueViolation(error)) throw error;
      const duplicate = await this.directives.findOne({
        where: { sessionId, clientTurnId: dto.clientTurnId },
      });
      if (!duplicate) throw error;
      return this.toDirectiveDto(duplicate);
    }

    if (result.consumesAttempt) {
      currentTurn.userAnswerText = dto.transcript;
      currentTurn.userAnswerTranscript = dto.modality === 'AUDIO' ? dto.transcript : null;
      currentTurn.modality = dto.modality;
      currentTurn.answeredAt = dto.speechEndedAt ? new Date(dto.speechEndedAt) : new Date();
      currentTurn.durationSeconds = dto.durationSeconds ?? null;
      currentTurn.responseDelayMs = dto.responseDelayMs ?? null;
      currentTurn.transcriptSegments = dto.transcriptSegments ?? null;
      currentTurn.clientTurnId = dto.clientTurnId;
      currentTurn.directiveId = saved.id;
      currentTurn.candidateIntent = dto.intent;
      currentTurn.assistanceLevel = result.assistanceLevel;
      currentTurn.scoreCap = result.scoreCap;
      currentTurn.skipReason = dto.intent === 'SKIP' ? result.reasons[0] : null;
      currentTurn.perQuestionScore =
        result.threadScore === null ? null : String(result.threadScore);
      await this.turns.save(currentTurn);
    }

    session.interviewState = this.withRealtimeState(session.interviewState, {
      ...result.state,
      topicHistory: this.nextTopicHistory(state.topicHistory, result.state.topicId),
      questionFingerprints: state.questionFingerprints,
    });
    await this.sessions.save(session);
    return this.toDirectiveDto(saved);
  }

  async commitAssistantMessage(
    userId: string,
    sessionId: string,
    directiveId: string,
    dto: CommitRealtimeAssistantMessageDto,
  ): Promise<{ directive: RealtimeTurnDirectiveDto; turnId: string | null }> {
    const session = await this.ownedSession(userId, sessionId);
    const directive = await this.directives.findOne({ where: { id: directiveId, sessionId } });
    if (!directive) throw new NotFoundException('Interview directive not found');
    if (directive.committedAt) {
      const persistedTurn = await this.turns.findOne({
        where: { sourceDirectiveId: directive.id },
      });
      return {
        directive: this.toDirectiveDto(directive),
        turnId: persistedTurn?.id ?? directive.turnId,
      };
    }

    directive.assistantResponseId = dto.responseId;
    directive.assistantMessage = dto.interviewerMessage ?? null;
    directive.assistantQuestion = dto.interviewerQuestion;
    directive.firstAudioAt = dto.firstAudioAt ? new Date(dto.firstAudioAt) : null;
    directive.assistantInterrupted = dto.interrupted ?? false;
    directive.committedAt = new Date();

    let turnId: string | null = directive.turnId;
    const preservesConsumedAttempt =
      directive.action === 'LOWER_DIFFICULTY' && directive.consumesAttempt;
    if (
      (this.createsQuestionTurn(directive.action) || preservesConsumedAttempt) &&
      !directive.finished
    ) {
      const current = await this.turns.findOne({
        where: { id: directive.turnId ?? undefined, sessionId },
      });
      const alreadyCreated = await this.turns.findOne({
        where: { sourceDirectiveId: directive.id },
      });
      if (alreadyCreated) {
        turnId = alreadyCreated.id;
      } else if (current) {
        const next = this.turns.create({
          sessionId,
          turnOrder: current.turnOrder + 1,
          phase: current.phase,
          topicPhase: current.topicPhase,
          modality: session.mode === 'TEXT' ? 'TEXT' : 'AUDIO',
          interviewerMessage: dto.interviewerMessage ?? null,
          interviewerQuestion: dto.interviewerQuestion,
          questionThreadId: directive.questionThreadId,
          sourceDirectiveId: directive.id,
          currentThread: directive.questionGoal,
          skillCanonical: directive.topicId,
          timeBudgetSeconds: directive.action === 'FOLLOW_UP' ? 60 : 90,
        });
        turnId = (await this.turns.save(next)).id;
      }
    } else if (!directive.finished && directive.turnId) {
      const current = await this.turns.findOne({ where: { id: directive.turnId, sessionId } });
      if (current) {
        current.interviewerMessage = dto.interviewerMessage ?? null;
        current.interviewerQuestion = dto.interviewerQuestion;
        current.questionThreadId = directive.questionThreadId;
        current.assistanceLevel = directive.assistanceLevel as InterviewAssistanceLevel;
        current.scoreCap = directive.scoreCap;
        current.answeredAt = null;
        current.userAnswerText = null;
        current.userAnswerTranscript = null;
        turnId = (await this.turns.save(current)).id;
      }
    }

    const state = this.realtimeState(session, null, this.agendaTopics(session.agenda));
    const fingerprint = this.fingerprint(dto.interviewerQuestion);
    session.interviewState = this.withRealtimeState(session.interviewState, {
      ...state,
      questionFingerprints: fingerprint
        ? [
            ...state.questionFingerprints.filter((value) => value !== fingerprint),
            fingerprint,
          ].slice(-100)
        : state.questionFingerprints,
    });
    await this.sessions.save(session);
    await this.directives.save(directive);
    return { directive: this.toDirectiveDto(directive), turnId };
  }

  private async ownedSession(userId: string, sessionId: string): Promise<InterviewSessionEntity> {
    const session = await this.sessions.findOne({ where: { id: sessionId, userId } });
    if (!session) throw new NotFoundException('Interview session not found');
    if (session.status !== 'IN_PROGRESS')
      throw new ConflictException('Interview session has ended');
    return session;
  }

  private agendaTopics(value: unknown): RealtimeAgendaTopic[] {
    if (!value || typeof value !== 'object') return [];
    const topics = (value as { topics?: unknown }).topics;
    if (!Array.isArray(topics)) return [];
    return topics.filter(
      (topic): topic is RealtimeAgendaTopic =>
        Boolean(topic) &&
        typeof topic === 'object' &&
        typeof (topic as { id?: unknown }).id === 'string',
    );
  }

  private realtimeState(
    session: InterviewSessionEntity,
    currentTurn: InterviewTurnEntity | null,
    topics: RealtimeAgendaTopic[],
  ): RealtimeInterviewState {
    const root =
      session.interviewState && typeof session.interviewState === 'object'
        ? (session.interviewState as Record<string, unknown>)
        : {};
    const value = root.realtime;
    if (value && typeof value === 'object') return value as RealtimeInterviewState;
    return {
      topicId: topics[0]?.id ?? currentTurn?.skillCanonical ?? 'general',
      questionThreadId: currentTurn?.questionThreadId ?? crypto.randomUUID(),
      difficultyStep: 0,
      noAnswerCount: 0,
      probeCount: 0,
      assistanceLevel: 'NONE',
      scoreCap: null,
      topicHistory: [],
      questionFingerprints: [],
    };
  }

  private withRealtimeState(
    rootValue: unknown,
    state: RealtimeInterviewState,
  ): Record<string, unknown> {
    const root =
      rootValue && typeof rootValue === 'object' ? (rootValue as Record<string, unknown>) : {};
    return { ...root, realtime: state };
  }

  private nextTopic(
    topics: RealtimeAgendaTopic[],
    state: RealtimeInterviewState,
  ): RealtimeAgendaTopic | null {
    const index = topics.findIndex((topic) => topic.id === state.topicId);
    return topics[index + 1] ?? null;
  }

  private nextTopicHistory(history: string[], topicId: string): string[] {
    return history.includes(topicId) ? history : [...history, topicId];
  }

  private effectiveAnswerSignal(
    intent: string,
    answerSignal: RealtimeAnswerSignal,
    signals: AnswerSignals,
  ): RealtimeAnswerSignal {
    if (intent !== 'ANSWER' || answerSignal !== 'COMPLETE') return answerSignal;
    return signals.flags.is_too_short ? 'PARTIAL' : answerSignal;
  }
  private fallbackQuestion(
    action: InterviewDirectiveAction,
    current: InterviewTurnEntity,
    nextTopic: RealtimeAgendaTopic | null,
    language: 'vi' | 'en',
    signals: AnswerSignals,
  ): string {
    if (action === 'ADVANCE_TOPIC') {
      return (
        nextTopic?.seed_question ??
        (language === 'vi'
          ? 'Bạn có thể chia sẻ một ví dụ khác liên quan đến năng lực tiếp theo không?'
          : 'Could you share another example related to the next competency?')
      );
    }
    if (action === 'REPEAT') return current.interviewerQuestion;
    if (action === 'FOLLOW_UP') {
      if (signals.ownership.first_person === 0) {
        return language === 'vi'
          ? 'Trong ví dụ đó, phần nào bạn trực tiếp thiết kế hoặc triển khai?'
          : 'In that example, which part did you personally design or implement?';
      }
      if (signals.flags.no_concrete_example || !signals.star.action || signals.word_count < 35) {
        return language === 'vi'
          ? 'Trong phần việc đó, quyết định kỹ thuật cụ thể nào do bạn trực tiếp đưa ra?'
          : 'What specific technical decision did you personally make in that work?';
      }
      if (!signals.star.result || !signals.is_quantified) {
        return language === 'vi'
          ? 'Kết quả cụ thể của phần việc đó là gì?'
          : 'What concrete result came from that work?';
      }
      return language === 'vi'
        ? 'Trade-off khó nhất trong quyết định đó là gì?'
        : 'What was the hardest trade-off in that decision?';
    }
    if (action === 'LOWER_DIFFICULTY' || action === 'DECLINE_COACHING') {
      const skill = this.publicSkillLabel(current.skillCanonical, language);
      return language === 'vi'
        ? 'Với ' + skill + ', bạn sẽ bắt đầu xử lý một tình huống cơ bản như thế nào?'
        : 'With ' + skill + ', how would you start handling a basic situation?';
    }
    if (action === 'GIVE_HINT') {
      return language === 'vi'
        ? `Gợi ý ngắn: hãy bắt đầu từ phần bạn trực tiếp thực hiện. ${current.interviewerQuestion}`
        : `A short hint: start with what you personally did. ${current.interviewerQuestion}`;
    }
    if (action === 'GIVE_FEEDBACK') {
      return language === 'vi'
        ? `Nhận xét nhanh: hãy làm rõ vai trò và kết quả của bạn. ${current.interviewerQuestion}`
        : `Quick feedback: make your role and result clearer. ${current.interviewerQuestion}`;
    }
    if (action === 'CLARIFY') {
      return language === 'vi'
        ? 'Câu hỏi này muốn biết một quyết định cụ thể của bạn trong tình huống vừa nêu.'
        : 'This question asks for one specific decision you made in the situation you described.';
    }
    if (action === 'WRAP_UP') {
      return language === 'vi'
        ? 'Cảm ơn bạn. Buổi phỏng vấn của chúng ta kết thúc tại đây.'
        : 'Thank you. This concludes our interview.';
    }
    return current.interviewerQuestion;
  }
  private publicSkillLabel(
    skillCanonical: string | null | undefined,
    language: 'vi' | 'en',
  ): string {
    const value = skillCanonical
      ?.trim()
      .replace(/[_-]+/g, ' ')
      .replace(/[^a-zA-Z0-9+#. ]+/g, '');
    if (value) return value;
    return language === 'vi' ? 'chủ đề này' : 'this topic';
  }
  private createsQuestionTurn(action: string): boolean {
    return action === 'FOLLOW_UP' || action === 'ADVANCE_TOPIC';
  }

  private toDirectiveDto(value: InterviewRealtimeDirectiveEntity): RealtimeTurnDirectiveDto {
    return {
      directiveId: value.id,
      action: value.action as InterviewDirectiveAction,
      topicId: value.topicId,
      questionThreadId: value.questionThreadId,
      difficultyStep: value.difficultyStep,
      assistanceLevel: value.assistanceLevel as InterviewAssistanceLevel,
      scoreCap: value.scoreCap,
      threadScore: value.threadScore,
      consumesAttempt: value.consumesAttempt,
      fallbackQuestion: value.questionGoal,
      finished: value.finished,
    };
  }

  private isUniqueViolation(error: unknown): boolean {
    return Boolean(
      error && typeof error === 'object' && (error as { code?: unknown }).code === '23505',
    );
  }

  private fingerprint(question: string): string {
    return question
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9+#.]+/g, ' ')
      .trim();
  }
}

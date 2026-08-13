import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, Repository } from 'typeorm';
import { SkillTextScannerService } from '../../common/services/skill-text-scanner.service';
import { InterviewSessionEntity } from '../../database/entities/interview-session.entity';
import { InterviewTurnEntity } from '../../database/entities/interview-turn.entity';
import {
  CandidateIntent,
  RealtimeExchangeDisposition,
  RealtimeExchangeResponseDto,
  RealtimeInterviewTurnDto,
} from './dto/interview.dto';
import { InterviewChainLlmService } from './interview-chain-llm.service';

interface RealtimeAgendaTopic {
  id: string;
  phase?: string;
  display_name?: string;
  what_to_probe?: string;
  seed_question?: string;
  seniority_target?: string;
  skill_canonical?: string | null;
  question_bank_item_id?: string;
  question_bank_key?: string;
}

interface PersistedExchange {
  clientTurnId: string;
  disposition: RealtimeExchangeDisposition;
  answeredTurnId: string | null;
  currentTurnId: string | null;
  responseId: string | null;
  transcript: string;
  question: string | null;
  finished: boolean;
}

interface RealtimeStateV3 {
  protocolVersion: 'interview-realtime-v3';
  currentTopicId: string | null;
  topicHistory: string[];
  questionFingerprints: string[];
  probeCount: number;
  noAnswerCount: number;
  exchanges: PersistedExchange[];
}

const CONTROL_WITHOUT_ATTEMPT = new Set<CandidateIntent>([
  'REPEAT',
  'CLARIFY',
  'EASIER',
  'HINT',
  'FEEDBACK',
]);
const INTERNAL_MARKERS = [
  'you are english',
  'question fingerprint',
  'questiongoal',
  'scorecap',
  'fallback question',
  'role-only practice',
  'no cv or job description',
  'decide_interview_turn',
];
const PHASE_ORDER = [
  'SCREENING',
  'SKILL_PROBE',
  'JD_REQUIREMENT',
  'SCENARIO',
  'BEHAVIORAL',
  'WRAP',
];

@Injectable()
export class InterviewRealtimeService {
  constructor(
    @InjectRepository(InterviewSessionEntity)
    private readonly sessions: Repository<InterviewSessionEntity>,
    @InjectRepository(InterviewTurnEntity)
    private readonly turns: Repository<InterviewTurnEntity>,
    private readonly chain: InterviewChainLlmService,
    private readonly skillScanner: SkillTextScannerService,
  ) {}

  async submitTurn(
    userId: string,
    sessionId: string,
    dto: RealtimeInterviewTurnDto,
  ): Promise<RealtimeExchangeResponseDto> {
    this.validateContract(dto);
    if (dto.kind === 'TEXT_FALLBACK') {
      return this.submitTextFallback(userId, sessionId, dto);
    }

    try {
      return await this.sessions.manager.transaction((manager) =>
        this.commitExchange(manager, userId, sessionId, dto),
      );
    } catch (error) {
      if (!this.isUniqueViolation(error)) throw error;
      const duplicate = await this.findDuplicate(userId, sessionId, dto.clientTurnId);
      if (duplicate) return duplicate;
      throw error;
    }
  }

  private async submitTextFallback(
    userId: string,
    sessionId: string,
    dto: RealtimeInterviewTurnDto,
  ): Promise<RealtimeExchangeResponseDto> {
    const duplicate = await this.findDuplicate(userId, sessionId, dto.clientTurnId);
    if (duplicate) return duplicate;

    const session = await this.ownedSession(this.sessions.manager, userId, sessionId, false);
    const current = await this.turns.findOne({
      where: dto.questionTurnId
        ? { id: dto.questionTurnId, sessionId }
        : { sessionId, answeredAt: IsNull() },
      order: { turnOrder: 'DESC' },
    });
    if (!current || current.answeredAt) {
      throw new ConflictException({
        errorCode: 'INTERVIEW_STALE_QUESTION',
        message: 'The submitted question is no longer active.',
        currentTurnId: await this.currentTurnId(sessionId),
      });
    }

    const topics = this.agendaTopics(session.agenda);
    const state = this.realtimeState(session, current, topics);
    const nextTopic = this.selectNextTopic(topics, state, dto.text ?? '');
    const language = session.language === 'en' ? 'en' : 'vi';
    const ask = await this.chain.ask(userId, {
      sessionId,
      turnOrder: current.turnOrder + 1,
      decision: state.probeCount < 1 ? 'drill' : 'advance',
      language,
      seniorityTarget: nextTopic?.seniority_target ?? 'mid',
      currentTopic: nextTopic ?? this.topicForCurrent(topics, state, current),
      currentThread: current.currentThread ?? current.interviewerQuestion,
      recentQa: [{ question: current.interviewerQuestion, answer: dto.text ?? '' }],
      runningNotes: [],
      prevTopicOutcome: 'Answer stored for final scoring.',
      topicPhase: nextTopic?.phase ?? current.topicPhase,
      interviewContext: this.compactContext(session.contextSnapshot),
      avoidQuestions: await this.recentQuestions(sessionId),
    });

    const assistantTranscript = [ask.aiMessage, ask.question].filter(Boolean).join(' ').trim();
    return this.submitTurn(userId, sessionId, {
      kind: 'REALTIME_EXCHANGE',
      clientTurnId: dto.clientTurnId,
      questionTurnId: current.id,
      input: {
        type: dto.intent && dto.intent !== 'ANSWER' ? 'CONTROL' : 'ANSWER',
        modality: 'TEXT',
        transcript: dto.text,
        intent: dto.intent ?? 'ANSWER',
        intentSource: 'TEXT',
        segmentCount: 1,
      },
      assistant: {
        responseId: `text-${dto.clientTurnId}`,
        transcript: assistantTranscript,
        interrupted: false,
      },
    });
  }

  private async commitExchange(
    manager: EntityManager,
    userId: string,
    sessionId: string,
    dto: RealtimeInterviewTurnDto,
  ): Promise<RealtimeExchangeResponseDto> {
    const session = await this.ownedSession(manager, userId, sessionId, true);
    const sessionTurns = manager.getRepository(InterviewTurnEntity);
    const topics = this.agendaTopics(session.agenda);
    const current = await sessionTurns.findOne({
      where: dto.questionTurnId
        ? { id: dto.questionTurnId, sessionId }
        : { sessionId, answeredAt: IsNull() },
      order: { turnOrder: 'DESC' },
      lock: { mode: 'pessimistic_write' },
    });
    const state = this.realtimeState(session, current, topics);
    const remembered = state.exchanges.find((entry) => entry.clientTurnId === dto.clientTurnId);
    if (remembered) return this.fromPersisted(remembered, 'DUPLICATE');

    const consumedDuplicate = await sessionTurns.findOne({
      where: { sessionId, clientTurnId: dto.clientTurnId },
    });
    if (consumedDuplicate) {
      return this.duplicateFromTurn(consumedDuplicate, current);
    }
    if (!current || current.answeredAt) {
      throw new ConflictException({
        errorCode: 'INTERVIEW_STALE_QUESTION',
        message: 'The submitted question is no longer active.',
        currentTurnId: current?.id ?? null,
      });
    }
    if (dto.questionTurnId && current.id !== dto.questionTurnId) {
      throw new ConflictException({
        errorCode: 'INTERVIEW_STALE_QUESTION',
        message: 'The submitted question is no longer active.',
        currentTurnId: current.id,
      });
    }

    const input = dto.input!;
    const assistant = dto.assistant!;
    this.assertPublicAssistant(assistant.transcript, session.language);
    const intent = input.intent ?? 'ANSWER';

    if (input.type === 'CAPTURE_RETRY') {
      const response = this.response(
        dto.clientTurnId,
        'CAPTURE_RETRY',
        null,
        current.id,
        assistant.responseId,
        assistant.transcript,
        current.interviewerQuestion,
        false,
      );
      this.rememberExchange(session, state, response);
      await manager.getRepository(InterviewSessionEntity).save(session);
      return response;
    }

    if (input.type === 'CONTROL' && CONTROL_WITHOUT_ATTEMPT.has(intent)) {
      this.applyControl(current, intent, assistant.transcript);
      await sessionTurns.save(current);
      const response = this.response(
        dto.clientTurnId,
        'CONTROL_APPLIED',
        null,
        current.id,
        assistant.responseId,
        assistant.transcript,
        current.interviewerQuestion,
        false,
      );
      this.rememberExchange(session, state, response);
      await manager.getRepository(InterviewSessionEntity).save(session);
      return response;
    }

    const transcript = (input.transcript ?? '').trim();
    if (!transcript && intent !== 'SKIP' && intent !== 'NO_ANSWER') {
      throw new BadRequestException({
        errorCode: 'INTERVIEW_EMPTY_ANSWER',
        message: 'A committed answer must include a transcript.',
      });
    }

    const answeredAt = input.speechEndedAt ? new Date(input.speechEndedAt) : new Date();
    current.userAnswerText = transcript;
    current.userAnswerTranscript = input.modality === 'AUDIO' ? transcript : null;
    current.modality = input.modality;
    current.answeredAt = answeredAt;
    current.durationSeconds = this.durationSeconds(input.speechStartedAt, input.speechEndedAt);
    current.transcriptSegments = input.segmentCount ?? null;
    current.clientTurnId = dto.clientTurnId;
    current.candidateIntent = intent;
    current.assistantResponseId = assistant.responseId;
    current.firstAudioAt = assistant.firstAudioAt ? new Date(assistant.firstAudioAt) : null;
    current.assistantInterrupted = assistant.interrupted;
    this.applyConsumedAssistance(current, intent, state);
    await sessionTurns.save(current);

    const extractedQuestion = this.extractQuestion(assistant.transcript);
    const nextTopic =
      intent === 'END'
        ? null
        : this.selectNextTopic(
            topics,
            state,
            `${transcript} ${extractedQuestion ?? assistant.transcript}`,
          );
    const question =
      extractedQuestion ??
      (intent === 'END' ? null : this.fallbackQuestion(nextTopic, session.language));
    const finished = intent === 'END';
    let next: InterviewTurnEntity | null = null;
    if (!finished && question) {
      const sameThread = intent === 'NO_ANSWER' && state.noAnswerCount === 0;
      next = sessionTurns.create({
        sessionId,
        turnOrder: current.turnOrder + 1,
        phase: (nextTopic?.phase as InterviewTurnEntity['phase'] | undefined) ?? current.phase,
        topicPhase:
          (nextTopic?.phase as InterviewTurnEntity['topicPhase'] | undefined) ?? current.topicPhase,
        modality: session.mode === 'TEXT' ? 'TEXT' : 'AUDIO',
        interviewerMessage: this.extractBridge(assistant.transcript, question),
        interviewerQuestion: question,
        questionThreadId: sameThread ? current.questionThreadId : crypto.randomUUID(),
        currentThread: nextTopic?.what_to_probe ?? question,
        skillCanonical: nextTopic?.skill_canonical ?? current.skillCanonical,
        questionBankItemId: null,
        questionBankKey: null,
        assistanceLevel: sameThread ? current.assistanceLevel : 'NONE',
        scoreCap: sameThread ? current.scoreCap : null,
        timeBudgetSeconds: 90,
      });
      next = await sessionTurns.save(next);
      this.advanceState(state, nextTopic, question, sameThread);
    }

    const response = this.response(
      dto.clientTurnId,
      'COMMITTED',
      current.id,
      next?.id ?? null,
      assistant.responseId,
      assistant.transcript,
      question,
      finished,
    );
    this.rememberExchange(session, state, response);
    await manager.getRepository(InterviewSessionEntity).save(session);
    return response;
  }

  private validateContract(dto: RealtimeInterviewTurnDto): void {
    if (dto.kind === 'REALTIME_EXCHANGE' && (!dto.input || !dto.assistant)) {
      throw new BadRequestException({
        errorCode: 'INTERVIEW_INVALID_EXCHANGE',
        message: 'REALTIME_EXCHANGE requires input and assistant payloads.',
      });
    }
    if (dto.kind === 'TEXT_FALLBACK' && !dto.text?.trim()) {
      throw new BadRequestException({
        errorCode: 'INTERVIEW_EMPTY_TEXT',
        message: 'TEXT_FALLBACK requires text.',
      });
    }
  }

  private async ownedSession(
    manager: EntityManager,
    userId: string,
    sessionId: string,
    lock: boolean,
  ): Promise<InterviewSessionEntity> {
    const session = await manager.getRepository(InterviewSessionEntity).findOne({
      where: { id: sessionId, userId },
      ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
    });
    if (!session) throw new NotFoundException('Interview session not found');
    if (session.status !== 'IN_PROGRESS') {
      throw new ConflictException({
        errorCode: 'INTERVIEW_SESSION_ENDED',
        message: 'Interview session has ended.',
      });
    }
    return session;
  }

  private async findDuplicate(
    userId: string,
    sessionId: string,
    clientTurnId: string,
  ): Promise<RealtimeExchangeResponseDto | null> {
    const session = await this.sessions.findOne({ where: { id: sessionId, userId } });
    if (!session) return null;
    const state = this.realtimeState(session, null, this.agendaTopics(session.agenda));
    const remembered = state.exchanges.find((entry) => entry.clientTurnId === clientTurnId);
    if (remembered) return this.fromPersisted(remembered, 'DUPLICATE');
    const answered = await this.turns.findOne({ where: { sessionId, clientTurnId } });
    if (!answered) return null;
    const current = await this.turns.findOne({
      where: { sessionId, answeredAt: IsNull() },
      order: { turnOrder: 'DESC' },
    });
    return this.duplicateFromTurn(answered, current);
  }

  private duplicateFromTurn(
    answered: InterviewTurnEntity,
    current: InterviewTurnEntity | null,
  ): RealtimeExchangeResponseDto {
    const transcript = [current?.interviewerMessage, current?.interviewerQuestion]
      .filter(Boolean)
      .join(' ');
    return this.response(
      answered.clientTurnId ?? '',
      'DUPLICATE',
      answered.id,
      current?.id ?? null,
      answered.assistantResponseId,
      transcript,
      current?.interviewerQuestion ?? null,
      !current,
    );
  }

  private response(
    clientTurnId: string,
    disposition: RealtimeExchangeDisposition,
    answeredTurnId: string | null,
    currentTurnId: string | null,
    responseId: string | null,
    transcript: string,
    question: string | null,
    finished: boolean,
  ): RealtimeExchangeResponseDto {
    return {
      clientTurnId,
      disposition,
      answeredTurnId,
      currentTurnId,
      assistant: transcript ? { responseId, transcript, question } : null,
      finished,
    };
  }

  private rememberExchange(
    session: InterviewSessionEntity,
    state: RealtimeStateV3,
    response: RealtimeExchangeResponseDto,
  ): void {
    const persisted: PersistedExchange = {
      clientTurnId: response.clientTurnId,
      disposition: response.disposition,
      answeredTurnId: response.answeredTurnId,
      currentTurnId: response.currentTurnId,
      responseId: response.assistant?.responseId ?? null,
      transcript: response.assistant?.transcript ?? '',
      question: response.assistant?.question ?? null,
      finished: response.finished,
    };
    state.exchanges = [
      ...state.exchanges.filter((entry) => entry.clientTurnId !== persisted.clientTurnId),
      persisted,
    ].slice(-50);
    const root = this.stateRoot(session.interviewState);
    session.interviewState = { ...root, realtime: state };
  }

  private fromPersisted(
    value: PersistedExchange,
    disposition: RealtimeExchangeDisposition,
  ): RealtimeExchangeResponseDto {
    return this.response(
      value.clientTurnId,
      disposition,
      value.answeredTurnId,
      value.currentTurnId,
      value.responseId,
      value.transcript,
      value.question,
      value.finished,
    );
  }

  private realtimeState(
    session: InterviewSessionEntity,
    current: InterviewTurnEntity | null,
    topics: RealtimeAgendaTopic[],
  ): RealtimeStateV3 {
    const root = this.stateRoot(session.interviewState);
    const raw =
      root.realtime && typeof root.realtime === 'object'
        ? (root.realtime as Record<string, unknown>)
        : {};
    const exchanges = Array.isArray(raw.exchanges)
      ? raw.exchanges.filter(this.isPersistedExchange)
      : [];
    return {
      protocolVersion: 'interview-realtime-v3',
      currentTopicId:
        typeof raw.currentTopicId === 'string'
          ? raw.currentTopicId
          : typeof raw.topicId === 'string'
            ? raw.topicId
            : (topics.find((topic) => topic.skill_canonical === current?.skillCanonical)?.id ??
              topics[0]?.id ??
              null),
      topicHistory: Array.isArray(raw.topicHistory)
        ? raw.topicHistory.filter((value): value is string => typeof value === 'string')
        : [],
      questionFingerprints: Array.isArray(raw.questionFingerprints)
        ? raw.questionFingerprints.filter((value): value is string => typeof value === 'string')
        : [],
      probeCount: typeof raw.probeCount === 'number' ? raw.probeCount : 0,
      noAnswerCount: typeof raw.noAnswerCount === 'number' ? raw.noAnswerCount : 0,
      exchanges,
    };
  }

  private stateRoot(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private isPersistedExchange(value: unknown): value is PersistedExchange {
    return Boolean(
      value &&
      typeof value === 'object' &&
      typeof (value as PersistedExchange).clientTurnId === 'string',
    );
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

  private topicForCurrent(
    topics: RealtimeAgendaTopic[],
    state: RealtimeStateV3,
    current: InterviewTurnEntity,
  ): RealtimeAgendaTopic | null {
    return (
      topics.find((topic) => topic.id === state.currentTopicId) ??
      topics.find((topic) => topic.skill_canonical === current.skillCanonical) ??
      null
    );
  }

  private selectNextTopic(
    topics: RealtimeAgendaTopic[],
    state: RealtimeStateV3,
    context: string,
  ): RealtimeAgendaTopic | null {
    const remaining = topics.filter(
      (topic) => topic.id !== state.currentTopicId && !state.topicHistory.includes(topic.id),
    );
    if (remaining.length === 0) return null;
    const nonScenario = remaining.filter(
      (topic) => !['SCENARIO', 'BEHAVIORAL'].includes(topic.phase ?? ''),
    );
    const pool = state.topicHistory.length < 2 && nonScenario.length > 0 ? nonScenario : remaining;
    const mentioned = new Set(this.skillScanner.scan(context).map((skill) => skill.canonical_name));
    return [...pool].sort((left, right) => {
      const skillDifference =
        Number(Boolean(right.skill_canonical && mentioned.has(right.skill_canonical))) -
        Number(Boolean(left.skill_canonical && mentioned.has(left.skill_canonical)));
      if (skillDifference !== 0) return skillDifference;
      const phaseDifference = this.phaseRank(left.phase) - this.phaseRank(right.phase);
      return phaseDifference !== 0 ? phaseDifference : topics.indexOf(left) - topics.indexOf(right);
    })[0];
  }

  private phaseRank(phase?: string): number {
    const rank = PHASE_ORDER.indexOf(phase ?? 'SKILL_PROBE');
    return rank < 0 ? PHASE_ORDER.length : rank;
  }

  private advanceState(
    state: RealtimeStateV3,
    topic: RealtimeAgendaTopic | null,
    question: string,
    sameThread: boolean,
  ): void {
    if (topic) {
      if (state.currentTopicId && !state.topicHistory.includes(state.currentTopicId)) {
        state.topicHistory.push(state.currentTopicId);
      }
      state.currentTopicId = topic.id;
    }
    state.probeCount = sameThread ? state.probeCount + 1 : 0;
    state.noAnswerCount = sameThread ? state.noAnswerCount + 1 : 0;
    const fingerprint = this.fingerprint(question);
    if (fingerprint && !state.questionFingerprints.includes(fingerprint)) {
      state.questionFingerprints.push(fingerprint);
      state.questionFingerprints = state.questionFingerprints.slice(-100);
    }
  }

  private applyControl(
    turn: InterviewTurnEntity,
    intent: CandidateIntent,
    assistantTranscript: string,
  ): void {
    const question = this.extractQuestion(assistantTranscript);
    if (question) turn.interviewerQuestion = question;
    turn.interviewerMessage = question ? this.extractBridge(assistantTranscript, question) : null;
    turn.assistantResponseId = null;
    if (intent === 'EASIER') {
      turn.assistanceLevel = turn.assistanceLevel === 'HINT' ? 'HINT' : 'EASIER';
      turn.scoreCap = this.lowerCap(turn.scoreCap, 75);
    }
    if (intent === 'HINT') {
      turn.assistanceLevel = 'HINT';
      turn.scoreCap = this.lowerCap(turn.scoreCap, 60);
    }
  }

  private applyConsumedAssistance(
    turn: InterviewTurnEntity,
    intent: CandidateIntent,
    state: RealtimeStateV3,
  ): void {
    if (intent === 'SKIP') {
      turn.assistanceLevel = 'SKIPPED';
      turn.scoreCap = 0;
      turn.skipReason = 'candidate_skip';
    } else if (intent === 'NO_ANSWER') {
      const cap = state.noAnswerCount === 0 ? 75 : 0;
      turn.assistanceLevel = 'EASIER';
      turn.scoreCap = this.lowerCap(turn.scoreCap, cap);
    } else {
      turn.assistanceLevel = turn.assistanceLevel ?? 'NONE';
    }
  }

  private lowerCap(current: number | null, next: number): number {
    return current === null ? next : Math.min(current, next);
  }

  private fallbackQuestion(topic: RealtimeAgendaTopic | null, language: string): string {
    const seed = topic?.seed_question?.trim();
    if (seed) return seed;
    return language === 'en'
      ? 'What technical decision from that work would you like to explain in more detail?'
      : 'Bạn có thể chia sẻ thêm một quyết định kỹ thuật quan trọng trong phần việc đó không?';
  }
  private extractQuestion(transcript: string): string | null {
    const normalized = transcript.replace(/\s+/g, ' ').trim();
    const matches = normalized.match(/[^.!?？]+[?？]/g);
    const question = matches?.at(-1)?.trim();
    if (question) return question;
    return null;
  }

  private extractBridge(transcript: string, question: string): string | null {
    const bridge = transcript.slice(0, transcript.lastIndexOf(question)).trim();
    return bridge || null;
  }

  private assertPublicAssistant(transcript: string, language: string): void {
    const normalized = transcript.toLowerCase();
    if (INTERNAL_MARKERS.some((marker) => normalized.includes(marker))) {
      throw new BadRequestException({
        errorCode: 'INTERVIEW_INTERNAL_OUTPUT_BLOCKED',
        message: 'The assistant response contained internal instructions.',
      });
    }
    if (
      (language === 'vi' || language === 'en') &&
      /[\u3400-\u9fff\uf900-\ufaff]/u.test(transcript)
    ) {
      throw new BadRequestException({
        errorCode: 'INTERVIEW_LANGUAGE_OUTPUT_BLOCKED',
        message: 'The assistant response did not match the session language.',
      });
    }
  }

  private durationSeconds(start?: string, end?: string): number | null {
    if (!start || !end) return null;
    const duration = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000);
    return Number.isFinite(duration) ? Math.max(0, duration) : null;
  }

  private fingerprint(value: string): string {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9+#. ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 220);
  }

  private compactContext(value: unknown): string {
    if (!value) return '';
    try {
      return JSON.stringify(value).slice(0, 6000);
    } catch {
      return '';
    }
  }

  private async recentQuestions(sessionId: string): Promise<string[]> {
    const turns = await this.turns.find({
      where: { sessionId },
      order: { turnOrder: 'DESC' },
      take: 10,
    });
    return turns.map((turn) => turn.interviewerQuestion);
  }

  private async currentTurnId(sessionId: string): Promise<string | null> {
    const turn = await this.turns.findOne({
      where: { sessionId, answeredAt: IsNull() },
      order: { turnOrder: 'DESC' },
    });
    return turn?.id ?? null;
  }

  private isUniqueViolation(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const code = (error as { code?: unknown }).code;
    return code === '23505' || code === 'SQLITE_CONSTRAINT';
  }
}

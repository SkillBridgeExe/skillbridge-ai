import { HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { maskPii } from '../../common/services/pii-mask';
import { ChatConversationEntity } from '../../database/entities/chat-conversation.entity';
import { ChatMessageEntity } from '../../database/entities/chat-message.entity';
import {
  buildDiagnosisFacts,
  DiagnosisChatResult,
  DiagnosisFacts,
} from '../../modules/diagnosis-chat/diagnosis-grounding';
import { DiagnosisChatService } from '../../modules/diagnosis-chat/diagnosis-chat.service';
import { TracingService } from '../../modules/tracing/tracing.service';
import { CvMatchesService } from '../cv-matches/cv-matches.service';
import { CvsService } from '../cvs/cvs.service';
import { DiagnosisChatCvOnlyRequestDto, DiagnosisChatRequestDto } from './dto/diagnosis-chat.dto';

const MAX_HISTORY = 10;
const DIAGNOSIS_CHAT_REQUEST_TYPE = 'diagnosis_chat';
const DAILY_CHAT_LIMIT = 50;

export interface DiagnosisChatTurnResponse {
  answer: string;
  cited_dimension?: string;
  cited_gap_id?: string;
  suggested_next_step?: string | null;
}

/**
 * Platform layer for the grounded CV-diagnosis advisor — mirrors LearningChatPlatformService:
 * assertQuota → resolveConversation (scoped {id,userId}, validating matchId) → build deterministic FACTS
 * from the user's OWN record (getGapReport for the JD-match path; getLatestReview for the CV-only path)
 * → maskPii(question) → tracing start/complete/markFailed → persist user + assistant chat messages with
 * the cited ids in metadata. The DTO NEVER carries client-supplied scores; every number is rebuilt here.
 */
@Injectable()
export class DiagnosisChatPlatformService {
  constructor(
    @InjectRepository(ChatConversationEntity)
    private readonly conversations: Repository<ChatConversationEntity>,
    @InjectRepository(ChatMessageEntity)
    private readonly messages: Repository<ChatMessageEntity>,
    private readonly chat: DiagnosisChatService,
    private readonly cvMatches: CvMatchesService,
    private readonly cvs: CvsService,
    private readonly tracing: TracingService,
  ) {}

  /**
   * JD-match path: `POST /api/cv-matches/:matchId/chat`. FACTS prefer the ownership-scoped gap report
   * (with CV-only degrade when a cvId is supplied and the match is absent). Conversation keyed by
   * (userId, matchId). Unchanged contract.
   */
  async turn(
    userId: string,
    matchId: string,
    dto: DiagnosisChatRequestDto,
  ): Promise<DiagnosisChatTurnResponse> {
    const facts = await this.buildFacts(userId, matchId, dto.cvId);
    const conversation = await this.resolveConversation(userId, matchId);
    return this.runTurn(userId, conversation, facts, dto, { match_id: matchId });
  }

  /**
   * CV-only path: `POST /api/cvs/:cvId/diagnosis-chat` — a scan with NO JD match. FACTS are built ONLY
   * from the user's OWN latest CV review (gap_items []); ownership is enforced by getLatestReview being
   * userId-scoped — a non-owned/missing cv yields null → a clean 404 (never another user's data).
   * Conversation keyed by (userId, cvId) with matchId NULL, so it never collides with a JD chat for the
   * same CV. Quota / maskPii / tracing / persistence / fallback are identical to the JD path.
   */
  async turnCvOnly(
    userId: string,
    cvId: string,
    dto: DiagnosisChatCvOnlyRequestDto,
  ): Promise<DiagnosisChatTurnResponse> {
    const review = await this.cvs.getLatestReview(userId, cvId);
    if (!review) {
      // Non-owned cv OR a cv with no completed review → honest 404, no cross-user data, no crash.
      throw new NotFoundException('CV diagnosis not found');
    }
    const facts = buildDiagnosisFacts(review, null);
    const conversation = await this.resolveCvConversation(userId, cvId);
    return this.runTurn(userId, conversation, facts, dto, { cv_id: cvId });
  }

  /**
   * Shared turn body for BOTH routes: quota → tracing start → maskPii(question) ONCE → persist user row
   * → chat.turn over the deterministic FACTS → persist assistant row → tracing complete. `subject`
   * (match_id OR cv_id) is threaded into the tracing payload + the user-row metadata only.
   */
  private async runTurn(
    userId: string,
    conversation: ChatConversationEntity,
    facts: DiagnosisFacts,
    dto: DiagnosisChatRequestDto | DiagnosisChatCvOnlyRequestDto,
    subject: { match_id: string } | { cv_id: string },
  ): Promise<DiagnosisChatTurnResponse> {
    await this.assertQuota(userId);
    const history = await this.loadHistory(conversation.id);

    const aiRequestId = await this.tracing.startAiRequest({
      userId,
      modelCode: '',
      requestType: DIAGNOSIS_CHAT_REQUEST_TYPE,
      requestPayload: {
        conversation_id: conversation.id,
        ...subject,
        focus: dto.focus ?? null,
        message_length: dto.question.length,
      },
    });

    // Mask ONCE: PII must never land in the persisted audit/history store NOR reach the LLM. The same
    // masked value is used for both the persisted user row and the prompt-bound question.
    const maskedQuestion = maskPii(dto.question);

    try {
      await this.messages.save(
        this.messages.create({
          conversationId: conversation.id,
          role: 'user',
          content: maskedQuestion,
          metadata: { ...subject, focus: dto.focus ?? null },
        }),
      );

      // History is loaded from our own persisted rows — mask each turn here too, mirroring learning-chat.
      const answer = await this.chat.turn({
        question: maskedQuestion,
        facts,
        focus: dto.focus,
        language: dto.language ?? 'vi',
        history: history.map((m) => ({ role: m.role, content: maskPii(m.content) })),
      });

      await this.messages.save(
        this.messages.create({
          conversationId: conversation.id,
          role: 'assistant',
          content: answer.answer,
          metadata: {
            cited_dimension: answer.cited_dimension ?? null,
            cited_gap_id: answer.cited_gap_id ?? null,
            suggested_next_step: answer.suggested_next_step ?? null,
          },
        }),
      );

      await this.tracing.completeAiRequest(aiRequestId, {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        latencyMs: 0,
        status: 'SUCCESS',
      });

      return this.toResponse(answer);
    } catch (err) {
      await this.tracing.markFailed(aiRequestId, Date.now(), err);
      throw err;
    }
  }

  /**
   * Deterministic FACTS — the ONLY number source. Prefer the JD-match gap report (ownership-scoped,
   * carries the CV review + gap_items). When it can't be built (e.g. CV-only, no JD match) and a cvId
   * is supplied, fall back to the latest CV review with NO gap_items. Both paths rebuild every number
   * server-side; the client supplies none.
   */
  private async buildFacts(
    userId: string,
    matchId: string,
    cvId?: string,
  ): Promise<DiagnosisFacts> {
    try {
      const report = await this.cvMatches.getGapReport(userId, matchId);
      // getGapReport already validated ownership + loaded the review-derived dimensions/gap_items, but
      // the report only carries gap_items + overall_score — re-read the review for the full dimension
      // breakdown when a cvId is known; otherwise distill from the report alone.
      const review = cvId ? await this.cvs.getLatestReview(userId, cvId) : null;
      return buildDiagnosisFacts(review, report);
    } catch (err) {
      // Only the ownership/absence NotFound degrades to the CV-only path. A real/transient error
      // (e.g. a DB fault) must surface — never let it masquerade as "no JD match".
      if (!(err instanceof NotFoundException)) throw err;
      if (cvId) {
        const review = await this.cvs.getLatestReview(userId, cvId);
        if (review) return buildDiagnosisFacts(review, null);
      }
      // No JD match AND no usable CV → surface the 404 (don't fabricate a degraded answer).
      throw err;
    }
  }

  private async assertQuota(userId: string): Promise<void> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const count = await this.tracing.countRequestsSince(userId, DIAGNOSIS_CHAT_REQUEST_TYPE, since);
    if (count >= DAILY_CHAT_LIMIT) {
      throw new HttpException(
        {
          errorCode: ERROR_CODES.FEATURE_USAGE_LIMIT_REACHED,
          message: 'Daily diagnosis chat limit reached',
        },
        429,
      );
    }
  }

  /**
   * One conversation per (user, match). Scoped by {userId, matchId} so a user can never read another
   * user's thread. getGapReport(userId, matchId) in buildFacts also enforces ownership of the match.
   */
  private async resolveConversation(
    userId: string,
    matchId: string,
  ): Promise<ChatConversationEntity> {
    const existing = await this.conversations.findOne({ where: { userId, matchId } });
    if (existing) return existing;
    return this.conversations.save(this.conversations.create({ userId, matchId, title: null }));
  }

  /**
   * One conversation per (user, cv) for the CV-only path. Scoped by {userId, cvId, matchId: IS NULL} so
   * it can never read another user's thread AND never collides with a JD chat for the same CV (which is
   * keyed by matchId, with cvId left null). Ownership of the cv is already enforced upstream by
   * getLatestReview(userId, cvId) being userId-scoped.
   */
  private async resolveCvConversation(
    userId: string,
    cvId: string,
  ): Promise<ChatConversationEntity> {
    const existing = await this.conversations.findOne({
      where: { userId, cvId, matchId: IsNull() },
    });
    if (existing) return existing;
    return this.conversations.save(
      this.conversations.create({ userId, cvId, matchId: null, title: null }),
    );
  }

  private async loadHistory(conversationId: string) {
    const rows = await this.messages.find({
      where: { conversationId },
      order: { createdAt: 'DESC' },
      take: MAX_HISTORY,
    });
    return rows.reverse().map((message) => ({ role: message.role, content: message.content }));
  }

  private toResponse(answer: DiagnosisChatResult): DiagnosisChatTurnResponse {
    const out: DiagnosisChatTurnResponse = { answer: answer.answer };
    if (answer.cited_dimension) out.cited_dimension = answer.cited_dimension;
    if (answer.cited_gap_id) out.cited_gap_id = answer.cited_gap_id;
    if (answer.suggested_next_step !== undefined) {
      out.suggested_next_step = answer.suggested_next_step;
    }
    return out;
  }
}

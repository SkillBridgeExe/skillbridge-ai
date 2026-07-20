import { HttpException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { maskPii } from '../../common/services/pii-mask';
import { ChatConversationEntity } from '../../database/entities/chat-conversation.entity';
import { ChatMessageEntity } from '../../database/entities/chat-message.entity';
import {
  buildCvBuilderFacts,
  CvBuilderChatFacts,
} from '../../modules/cv-builder-chat/cv-builder-chat.facts';
import { buildDiagnosisChatBlock } from '../../modules/cv-builder-chat/cv-builder-diagnosis';
import {
  CvBuilderChatResult,
  CvBuilderKnownState,
  CvChatAnswerKind,
  CvGroundedFact,
} from '../../modules/cv-builder-chat/cv-chat-grounding';
import { CvBuilderChatService } from '../../modules/cv-builder-chat/cv-builder-chat.service';
import { TracingService } from '../../modules/tracing/tracing.service';
import { CvsService } from '../cvs/cvs.service';
import { CvBuilderChatRequestDto } from './dto/cv-builder-chat.dto';

/** Same wider slice as diagnosis-chat: the domain service only prompts over its own MAX_HISTORY
 *  window, but the platform layer loads more so a later conversation-state extractor (Slice 2)
 *  has room to look back past the prompt transcript. Matches getThread's window too. */
const STATE_WINDOW = 40;
const CV_BUILDER_CHAT_REQUEST_TYPE = 'cv_builder_chat';
const DAILY_CHAT_LIMIT = 50;

const DEFAULT_KNOWN_STATE: CvBuilderKnownState = {
  target_role: null,
  active_field_path: null,
  answered_gaps: [],
};

export interface CvBuilderChatTurnResponse {
  answer: string;
  answer_kind: CvChatAnswerKind;
  proposed_edit: { field_path: string; before: string; after: string } | null;
  grounded_facts: CvGroundedFact[];
  suggested_next_step: string | null;
  known_state: CvBuilderKnownState;
}

export interface CvBuilderChatThreadResponse {
  turns: Array<{ role: 'user' | 'assistant'; text: string; ts: string }>;
  known_state?: CvBuilderKnownState;
}

/**
 * Platform layer for the grounded CV-builder chat companion — mirrors DiagnosisChatPlatformService's
 * CV-only path: assertQuota → resolveCvBuilderConversation (scoped {userId, cvId, matchId: NULL,
 * purpose: 'cv_builder'}) → build deterministic FACTS from the user's OWN draft (getOwnedCvForChat,
 * ownership-gated) → maskPii(question) → tracing start/complete/markFailed → persist user + assistant
 * chat rows. There is no JD match here (no otherMatches machinery) and no client-supplied thread —
 * history is loaded from our own persisted rows only.
 */
@Injectable()
export class CvBuilderChatPlatformService {
  constructor(
    @InjectRepository(ChatConversationEntity)
    private readonly conversations: Repository<ChatConversationEntity>,
    @InjectRepository(ChatMessageEntity)
    private readonly messages: Repository<ChatMessageEntity>,
    private readonly chat: CvBuilderChatService,
    private readonly cvs: CvsService,
    private readonly tracing: TracingService,
  ) {}

  /**
   * `POST /api/cvs/:cvId/builder/chat`. target_role and the draft document are read server-side from
   * the owned CV — the DTO carries no role/fact field, so the FE can never inject one.
   */
  async turn(
    userId: string,
    cvId: string,
    dto: CvBuilderChatRequestDto,
  ): Promise<CvBuilderChatTurnResponse> {
    const {
      document,
      targetRole,
      language: cvLanguage,
    } = await this.cvs.getOwnedCvForChat(userId, cvId);
    // Latest CV scan for THIS draft; if this is a fresh clone that was never re-scanned, read the
    // parent (diagnosed) CV's review. source_cv_id is only a POINTER — getLatestReview is ownership-
    // scoped (JOIN cvs.user_id), so it can never become a cross-user fact-injection channel.
    let review = await this.cvs.getLatestReview(userId, cvId);
    if (!review && dto.source_cv_id) {
      review = await this.cvs.getLatestReview(userId, dto.source_cv_id);
    }
    const facts = buildCvBuilderFacts(
      document,
      dto.focused_field ?? null,
      targetRole,
      buildDiagnosisChatBlock(review),
    );
    const conversation = await this.resolveCvBuilderConversation(userId, cvId);
    return this.runTurn(userId, cvId, conversation, facts, dto, cvLanguage);
  }

  async getThread(userId: string, cvId: string): Promise<CvBuilderChatThreadResponse> {
    const conversation = await this.conversations.findOne({
      where: { userId, cvId, matchId: IsNull(), purpose: 'cv_builder' },
    });
    if (!conversation) return { turns: [] };

    const rows = await this.messages.find({
      where: { conversationId: conversation.id },
      order: { createdAt: 'ASC' },
    });

    const windowRows = rows.slice(-STATE_WINDOW);
    const lastAssistant = [...windowRows].reverse().find((m) => m.role === 'assistant');
    const known_state =
      (lastAssistant?.metadata as { known_state?: CvBuilderKnownState } | null)?.known_state ??
      DEFAULT_KNOWN_STATE;

    return {
      turns: windowRows.map((message) => ({
        role: message.role,
        text: message.content,
        ts: message.createdAt.toISOString(),
      })),
      known_state,
    };
  }

  async deleteThread(userId: string, cvId: string): Promise<void> {
    const conversation = await this.conversations.findOne({
      where: { userId, cvId, matchId: IsNull(), purpose: 'cv_builder' },
    });
    if (!conversation) return;

    await this.messages.delete({ conversationId: conversation.id });
    await this.conversations.delete({ id: conversation.id });
  }

  /**
   * Shared turn body: quota → tracing start → maskPii(question) ONCE → persist user row → chat.turn
   * over the deterministic FACTS → persist assistant row (carries known_state/grounded_facts/
   * proposed_edit/suggested_next_step in metadata so getThread can restore them) → tracing complete.
   */
  private async runTurn(
    userId: string,
    cvId: string,
    conversation: ChatConversationEntity,
    facts: CvBuilderChatFacts,
    dto: CvBuilderChatRequestDto,
    cvLanguage: string,
  ): Promise<CvBuilderChatTurnResponse> {
    await this.assertQuota(userId);
    const history = await this.loadHistory(conversation.id);

    const aiRequestId = await this.tracing.startAiRequest({
      userId,
      modelCode: '',
      requestType: CV_BUILDER_CHAT_REQUEST_TYPE,
      requestPayload: {
        conversation_id: conversation.id,
        cv_id: cvId,
        focused_field_path: dto.focused_field?.field_path ?? null,
        message_length: dto.question.length,
      },
    });

    // Mask ONCE: PII must never land in the persisted audit/history store NOR reach the LLM.
    const maskedQuestion = maskPii(dto.question);

    try {
      await this.messages.save(
        this.messages.create({
          conversationId: conversation.id,
          role: 'user',
          content: maskedQuestion,
          metadata: { cv_id: cvId, focused_field_path: dto.focused_field?.field_path ?? null },
        }),
      );

      const answer = await this.chat.turn({
        question: maskedQuestion,
        facts,
        // FE's explicit choice wins; otherwise fall back to the CV's own detected language before
        // the hardcoded default — respects a Vietnamese CV even when the client didn't specify.
        language: dto.language ?? cvLanguage ?? 'vi',
        history: history.map((m) => ({ role: m.role, content: maskPii(m.content), at: m.at })),
        userId,
        aiRequestId,
      });

      await this.messages.save(
        this.messages.create({
          conversationId: conversation.id,
          role: 'assistant',
          content: answer.answer,
          metadata: {
            proposed_edit: answer.proposed_edit ?? null,
            grounded_facts: answer.grounded_facts ?? [],
            known_state: answer.known_state ?? null,
            suggested_next_step: answer.suggested_next_step ?? null,
          },
        }),
      );

      await this.tracing
        .completeAiRequest(aiRequestId, {
          promptTokens: Number(answer.trace?.promptTokens ?? 0),
          completionTokens: Number(answer.trace?.completionTokens ?? 0),
          totalTokens: Number(answer.trace?.totalTokens ?? 0),
          latencyMs: Number(answer.trace?.latencyMs ?? 0),
          status: 'SUCCESS',
        })
        .catch(() => undefined);

      return this.toResponse(answer, facts);
    } catch (err) {
      await this.tracing.markFailed(aiRequestId, Date.now(), err).catch(() => undefined);
      throw err;
    }
  }

  private async assertQuota(userId: string): Promise<void> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const count = await this.tracing.countRequestsSince(
      userId,
      CV_BUILDER_CHAT_REQUEST_TYPE,
      since,
    );
    if (count >= DAILY_CHAT_LIMIT) {
      throw new HttpException(
        {
          errorCode: ERROR_CODES.FEATURE_USAGE_LIMIT_REACHED,
          message: 'Daily CV builder chat limit reached',
        },
        429,
      );
    }
  }

  /**
   * One conversation per (user, cv, purpose='cv_builder'). purpose is MANDATORY in both the
   * findOne where-clause and the create — without it this collides with the CV-only diagnosis
   * thread, which shares the exact same (userId, cvId, matchId: NULL) key.
   */
  private async resolveCvBuilderConversation(
    userId: string,
    cvId: string,
  ): Promise<ChatConversationEntity> {
    const existing = await this.conversations.findOne({
      where: { userId, cvId, matchId: IsNull(), purpose: 'cv_builder' },
    });
    if (existing) return existing;
    return this.conversations.save(
      this.conversations.create({
        userId,
        cvId,
        matchId: null,
        purpose: 'cv_builder',
        title: null,
      }),
    );
  }

  private async loadHistory(conversationId: string) {
    const rows = await this.messages.find({
      where: { conversationId },
      order: { createdAt: 'DESC' },
      take: STATE_WINDOW,
    });
    return rows.reverse().map((message) => ({
      role: message.role,
      content: message.content,
      at: message.createdAt.toISOString(),
    }));
  }

  private toResponse(
    answer: CvBuilderChatResult,
    facts: CvBuilderChatFacts,
  ): CvBuilderChatTurnResponse {
    return {
      answer: answer.answer,
      answer_kind: answer.answer_kind,
      proposed_edit: answer.proposed_edit ?? null,
      grounded_facts: answer.grounded_facts ?? [],
      suggested_next_step: answer.suggested_next_step ?? null,
      known_state: answer.known_state ?? {
        target_role: facts.target_role,
        active_field_path: facts.focus?.field_path ?? null,
        answered_gaps: [],
      },
    };
  }
}

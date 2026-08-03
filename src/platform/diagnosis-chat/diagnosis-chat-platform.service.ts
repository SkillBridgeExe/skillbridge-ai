import { HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { BillingPlanCode } from '../../common/constants/billing.constants';
import { maskPii } from '../../common/services/pii-mask';
import { ChatConversationEntity } from '../../database/entities/chat-conversation.entity';
import { ChatMessageEntity } from '../../database/entities/chat-message.entity';
import {
  buildDiagnosisFacts,
  DiagnosisChatResult,
  DiagnosisFacts,
  DiagnosisKnownState,
  GroundedFact,
} from '../../modules/diagnosis-chat/diagnosis-grounding';
import { extractConversationState } from '../../modules/diagnosis-chat/conversation-state';
import { DiagnosisChatService } from '../../modules/diagnosis-chat/diagnosis-chat.service';
import { TracingService } from '../../modules/tracing/tracing.service';
import { CvMatchesService, OtherMatchSummary } from '../cv-matches/cv-matches.service';
import { EntitlementsService } from '../billing/entitlements.service';
import { CvsService } from '../cvs/cvs.service';
import { diagnosisPremiumView } from '../cvs/diagnosis-premium-access';
import { DiagnosisChatCvOnlyRequestDto, DiagnosisChatRequestDto } from './dto/diagnosis-chat.dto';

/** The domain service still shows only its last-10 window to the LLM; it receives this WIDER slice
 *  so conversation-state extraction (target role, deadline, what was already asked) remembers past
 *  the prompt transcript. Matches getThread's 40-message ceiling. */
const STATE_WINDOW = 40;
const DIAGNOSIS_CHAT_REQUEST_TYPE = 'diagnosis_chat';
const DAILY_CHAT_LIMIT = 50;
type DiagnosisAccessLevel = 'free' | 'premium';

export interface DiagnosisChatTurnResponse {
  answer: string;
  /** Gate verdict forwarded for the FE mascot pose (Wave 1) — optional on the wire so older
   *  clients simply ignore it. */
  answer_kind?: 'grounded' | 'refusal' | 'canned';
  cited_dimension?: string;
  cited_gap_id?: string;
  suggested_next_step?: string | null;
  /** Deep-linkable ids for the other-JD-match the model cited (M1) — real match_id/cv_id resolved
   *  server-side from the validated cited_other_match_index; absent when no valid index was cited. */
  cited_match?: { match_id: string; cv_id: string; jd_title: string | null };
  /** Tool-call citation forwarded verbatim from grounding (M1 fix — was previously dropped here). */
  cited_tool?: string;
  /** Provenance behind the answer (Wave 2 "visible trust") — optional on the wire so older
   *  clients ignore it; absent when the turn advertised nothing. other_match ids are the REAL
   *  match_id (swapped from grounding's 1-based index here, same as cited_match). */
  grounded_facts?: GroundedFact[];
  /** Deterministic memory mirror — what the dolphin currently knows, verbatim. */
  known_state?: DiagnosisKnownState;
}

export interface DiagnosisChatThreadResponse {
  turns: Array<{ role: 'user' | 'assistant'; text: string; ts: string }>;
  /** Rebuilt from the SAME persisted rows the turns come from — deterministic, so the FE memory
   *  card is correct on restore. covered_gaps stays [] here: no facts are loaded on this path. */
  known_state?: DiagnosisKnownState;
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
  private readonly logger = new Logger(DiagnosisChatPlatformService.name);

  constructor(
    @InjectRepository(ChatConversationEntity)
    private readonly conversations: Repository<ChatConversationEntity>,
    @InjectRepository(ChatMessageEntity)
    private readonly messages: Repository<ChatMessageEntity>,
    private readonly chat: DiagnosisChatService,
    private readonly cvMatches: CvMatchesService,
    private readonly cvs: CvsService,
    private readonly tracing: TracingService,
    private readonly entitlements: EntitlementsService,
  ) {}

  /**
   * JD-match path: `POST /api/cv-matches/:matchId/chat`. FACTS are rebuilt from the owned match only:
   * gap report + the review for that match's own CV. A client-supplied cvId is ignored here; CV-only
   * diagnosis has its own route and match NotFound must fail closed.
   */
  async turn(
    userId: string,
    matchId: string,
    dto: DiagnosisChatRequestDto,
  ): Promise<DiagnosisChatTurnResponse> {
    const { facts, otherMatches, accessLevel } = await this.buildFactsForMatch(userId, matchId);
    const conversation = await this.resolveConversation(userId, matchId);
    return this.runTurn(
      userId,
      conversation,
      facts,
      dto,
      { match_id: matchId },
      otherMatches,
      accessLevel,
    );
  }

  async getThread(userId: string, matchId: string): Promise<DiagnosisChatThreadResponse> {
    const conversation = await this.conversations.findOne({ where: { userId, matchId } });
    if (!conversation) return { turns: [] };

    const rows = await this.messages.find({
      where: { conversationId: conversation.id },
      order: { createdAt: 'ASC' },
    });
    const unlocked = await this.entitlements.hasActivePlan(userId, BillingPlanCode.PREMIUM);
    const accessibleRows = rows.filter((message) => this.canReadMessage(message, unlocked));

    const windowRows = accessibleRows.slice(-40);
    // Deterministic mirror on restore: the SAME extractor the live turn uses, over the SAME
    // window — question is '' because there is no current turn. covered_gaps needs facts,
    // which this path never loads → honestly empty rather than a stale guess.
    const state = extractConversationState(
      windowRows.map((message) => ({
        role: message.role,
        content: message.content,
        at: message.createdAt.toISOString(),
      })),
      '',
    );
    return {
      turns: windowRows.map((message) => ({
        role: message.role,
        text: message.content,
        ts: message.createdAt.toISOString(),
      })),
      known_state: {
        target_role: state.target_role,
        deadline: state.deadline,
        covered_gaps: [],
      },
    };
  }

  async deleteThread(userId: string, matchId: string): Promise<void> {
    const conversation = await this.conversations.findOne({ where: { userId, matchId } });
    if (!conversation) return;

    await this.messages.delete({ conversationId: conversation.id });
    await this.conversations.delete({ id: conversation.id });
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
    const unlocked = await this.entitlements.hasActivePlan(userId, BillingPlanCode.PREMIUM);
    const facts = buildDiagnosisFacts(diagnosisPremiumView(review, unlocked).review, null);
    const conversation = await this.resolveCvConversation(userId, cvId);
    return this.runTurn(
      userId,
      conversation,
      facts,
      dto,
      { cv_id: cvId },
      [],
      unlocked ? 'premium' : 'free',
    );
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
    // Only the JD-match route has other-match summaries to map cited_other_match_index back to real
    // ids; the CV-only route has none, so it defaults to an empty list (cited_match never appears there).
    otherMatches: OtherMatchSummary[] = [],
    accessLevel: DiagnosisAccessLevel = 'free',
  ): Promise<DiagnosisChatTurnResponse> {
    await this.assertQuota(userId);
    const history = await this.loadHistory(conversation.id, accessLevel === 'premium');

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
            cited_dimension: answer.cited_dimension ?? null,
            cited_gap_id: answer.cited_gap_id ?? null,
            suggested_next_step: answer.suggested_next_step ?? null,
            diagnosis_access_level: accessLevel,
          },
        }),
      );

      await this.tracing
        .completeAiRequest(aiRequestId, {
          promptTokens: answer.trace?.promptTokens ?? 0,
          completionTokens: answer.trace?.completionTokens ?? 0,
          totalTokens: answer.trace?.totalTokens ?? 0,
          estimatedCost: answer.trace?.estimatedCostUsd,
          latencyMs: answer.trace?.latencyMs ?? 0,
          status: 'SUCCESS',
          modelCode: answer.trace?.modelCode,
        })
        .catch(() => undefined);

      return this.toResponse(answer, otherMatches);
    } catch (err) {
      await this.tracing.markFailed(aiRequestId, Date.now(), err).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Deterministic match FACTS — the ONLY number source for the JD-match route. The match id owns both
   * the gap report and the CV review. Do not use caller-supplied cvId here, otherwise a client could
   * mix gaps from one match with score dimensions from another CV.
   */
  private async buildFactsForMatch(
    userId: string,
    matchId: string,
  ): Promise<{
    facts: DiagnosisFacts;
    otherMatches: OtherMatchSummary[];
    accessLevel: DiagnosisAccessLevel;
  }> {
    const report = await this.cvMatches.getGapReport(userId, matchId);
    const review = await this.cvMatches.getReviewForMatch(userId, matchId);
    const unlocked = await this.entitlements.hasActivePlan(userId, BillingPlanCode.PREMIUM);
    const accessibleReview = review ? diagnosisPremiumView(review, unlocked).review : null;
    // Best-effort: a progress-lookup failure must never break the chat itself, but a silently
    // dropped fact should still surface somewhere (T5 — no more silent facts degradation).
    const progress = await this.cvMatches.getProgress(userId, matchId).catch((err: unknown) => {
      this.logger.warn(
        `diagnosis facts degraded: progress lookup failed (match=${matchId}): ${(err as Error)?.message}`,
      );
      return null;
    });
    // Best-effort: cross-match summaries add comparison context, but lookup failures must never
    // break the diagnosis chat — still logged so a degraded-facts pattern is visible. Kept in scope
    // (not just fed into facts) so a later cited_other_match_index can be mapped back to real ids (M1).
    const otherMatches = await this.cvMatches
      .listRecentMatchSummariesForUser(userId, matchId)
      .catch((err: unknown) => {
        this.logger.warn(
          `diagnosis facts degraded: other-matches lookup failed (match=${matchId}): ${(err as Error)?.message}`,
        );
        return [];
      });
    return {
      facts: buildDiagnosisFacts(accessibleReview, report, progress, otherMatches),
      otherMatches,
      accessLevel: unlocked ? 'premium' : 'free',
    };
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
   * One conversation per (user, cv, purpose='diagnosis') for the CV-only path. Scoped by
   * {userId, cvId, matchId: IS NULL, purpose: 'diagnosis'} so it can never read another user's thread
   * AND never collides with a JD chat for the same CV (keyed by matchId, cvId left null) NOR with the
   * CV-builder-chat thread (which shares the exact same (userId, cvId, matchId: NULL) key but tags its
   * rows purpose='cv_builder' — without this filter the two threads would corrupt each other). Ownership
   * of the cv is already enforced upstream by getLatestReview(userId, cvId) being userId-scoped.
   */
  private async resolveCvConversation(
    userId: string,
    cvId: string,
  ): Promise<ChatConversationEntity> {
    const existing = await this.conversations.findOne({
      where: { userId, cvId, matchId: IsNull(), purpose: 'diagnosis' },
    });
    if (existing) return existing;
    return this.conversations.save(
      this.conversations.create({ userId, cvId, matchId: null, purpose: 'diagnosis', title: null }),
    );
  }

  private async loadHistory(conversationId: string, unlocked: boolean) {
    const rows = await this.messages.find({
      where: { conversationId },
      order: { createdAt: 'DESC' },
      take: STATE_WINDOW,
    });
    // `at` feeds ONLY the deterministic deadline-expiry rule (Wave 3) — the transcript the model
    // sees stays timestamp-free.
    return rows
      .reverse()
      .filter((message) => this.canReadMessage(message, unlocked))
      .map((message) => ({
        role: message.role,
        content: message.content,
        at: message.createdAt.toISOString(),
      }));
  }

  /** Assistant answers may embed paid facts. Unlabelled legacy assistant rows fail closed. */
  private canReadMessage(message: ChatMessageEntity, unlocked: boolean): boolean {
    if (unlocked || message.role === 'user') return true;
    return message.metadata?.diagnosis_access_level === 'free';
  }

  private toResponse(
    answer: DiagnosisChatResult,
    otherMatches: OtherMatchSummary[],
  ): DiagnosisChatTurnResponse {
    const out: DiagnosisChatTurnResponse = {
      answer: answer.answer,
      answer_kind: answer.answer_kind,
    };
    if (answer.cited_dimension) out.cited_dimension = answer.cited_dimension;
    if (answer.cited_gap_id) out.cited_gap_id = answer.cited_gap_id;
    if (answer.suggested_next_step !== undefined) {
      out.suggested_next_step = answer.suggested_next_step;
    }
    // cited_other_match_index is 1-based (mirrors the LLM schema); map back to the real ids kept in
    // scope from listRecentMatchSummariesForUser — never leaked into the LLM-facing facts (M1).
    if (answer.cited_other_match_index !== undefined) {
      const match = otherMatches[answer.cited_other_match_index - 1];
      if (match) {
        out.cited_match = {
          match_id: match.match_id,
          cv_id: match.cv_id,
          jd_title: match.jd_title,
        };
      }
    }
    if (answer.cited_tool) out.cited_tool = answer.cited_tool;
    // Optional-chained: older DiagnosisChatResult mocks (and any defensive path) may omit the
    // field — the wire must degrade to "no provenance", never throw.
    if (answer.grounded_facts?.length) {
      const facts = answer.grounded_facts.flatMap((f): GroundedFact[] => {
        if (f.kind !== 'other_match') return [f];
        // Same swap cited_match does: grounding only knows the 1-based index; the real
        // deep-linkable id lives in the summaries kept in scope here. No summary → DROP the
        // fact — a raw index must never ship as an id.
        const match = otherMatches[Number(f.id) - 1];
        return match ? [{ ...f, id: match.match_id, label: match.jd_title ?? f.label }] : [];
      });
      if (facts.length) out.grounded_facts = facts;
    }
    if (answer.known_state) out.known_state = answer.known_state;
    return out;
  }
}

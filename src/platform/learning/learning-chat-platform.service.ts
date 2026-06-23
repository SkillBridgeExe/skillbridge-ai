import { BadRequestException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { ChatConversationEntity } from '../../database/entities/chat-conversation.entity';
import { ChatMessageEntity } from '../../database/entities/chat-message.entity';
import { ChatService } from '../../modules/learning-chat/learning-chat.service';
import { buildChatFacts } from '../../modules/learning-chat/chat-grounding';

import { TracingService } from '../../modules/tracing/tracing.service';
import { CvMatchesService } from '../cv-matches/cv-matches.service';
import { LearningChatRequestDto } from './dto/learning-chat.dto';

const MAX_HISTORY = 10;
const LEARNING_CHAT_REQUEST_TYPE = 'learning_chat';
const DAILY_CHAT_LIMIT = 50;

export interface LearningChatTurnResponse {
  conversationId: string;
  message: string;
  citations: Array<{ title: string; url?: string }>;
  suggestedNextStep: string | null;
}

export interface LearningChatHistoryResponse {
  conversationId: string;
  matchId: string | null;
  history: Array<{
    id: string;
    role: 'user' | 'assistant';
    message: string;
    text: string;
    createdAt: Date;
  }>;
}

@Injectable()
export class LearningChatPlatformService {
  constructor(
    @InjectRepository(ChatConversationEntity)
    private readonly conversations: Repository<ChatConversationEntity>,
    @InjectRepository(ChatMessageEntity)
    private readonly messages: Repository<ChatMessageEntity>,
    private readonly chat: ChatService,
    private readonly cvMatches: CvMatchesService,
    private readonly tracing: TracingService,
  ) {}

  async turn(userId: string, dto: LearningChatRequestDto): Promise<LearningChatTurnResponse> {
    await this.assertQuota(userId);
    const conversation = await this.resolveConversation(userId, dto);
    const matchId = conversation.matchId ?? dto.matchId ?? null;
    const facts = matchId
      ? buildChatFacts({ gapItems: (await this.cvMatches.getGapReport(userId, matchId)).gap_items })
      : { open_gaps: [] };
    const history = await this.loadHistory(conversation.id);

    const aiRequestId = await this.tracing.startAiRequest({
      userId,
      modelCode: '',
      requestType: LEARNING_CHAT_REQUEST_TYPE,
      requestPayload: {
        conversation_id: conversation.id,
        match_id: matchId,
        message_length: dto.message.length,
      },
    });

    try {
      await this.messages.save(
        this.messages.create({
          conversationId: conversation.id,
          role: 'user',
          content: dto.message,
          metadata: matchId ? { match_id: matchId } : null,
        }),
      );

      const answer = await this.chat.turn({
        question: dto.message,
        language: dto.language ?? 'vi',
        history,
        facts,
      });

      await this.messages.save(
        this.messages.create({
          conversationId: conversation.id,
          role: 'assistant',
          content: answer.message,
          metadata: {
            cited_resource_ids: answer.cited_resources.map((resource) => resource.resource_id),
            suggested_next_step: answer.suggested_next_step,
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

      return {
        conversationId: conversation.id,
        message: answer.message,
        citations: answer.cited_resources.map((res) => ({
          title: res.title,
          url: res.url,
        })),
        suggestedNextStep: answer.suggested_next_step,
      };
    } catch (err) {
      await this.tracing.markFailed(aiRequestId, Date.now(), err);
      throw err;
    }
  }

  async history(userId: string, conversationId: string): Promise<LearningChatHistoryResponse> {
    const conversation = await this.conversations.findOne({
      where: { id: conversationId, userId },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');

    const messages = await this.messages.find({
      where: { conversationId },
      order: { createdAt: 'ASC' },
    });
    return {
      conversationId: conversation.id,
      matchId: conversation.matchId,
      history: messages.map((message) => ({
        id: message.id,
        role: message.role as 'user' | 'assistant',
        message: message.content,
        text: message.content,
        createdAt: message.createdAt,
      })),
    };
  }

  private async assertQuota(userId: string): Promise<void> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const count = await this.tracing.countRequestsSince(userId, LEARNING_CHAT_REQUEST_TYPE, since);
    if (count >= DAILY_CHAT_LIMIT) {
      throw new HttpException(
        {
          errorCode: ERROR_CODES.FEATURE_USAGE_LIMIT_REACHED,
          message: 'Daily learning chat limit reached',
        },
        429,
      );
    }
  }

  private async resolveConversation(
    userId: string,
    dto: LearningChatRequestDto,
  ): Promise<ChatConversationEntity> {
    if (dto.conversationId) {
      const conversation = await this.conversations.findOne({
        where: { id: dto.conversationId, userId },
      });
      if (!conversation) throw new NotFoundException('Conversation not found');
      if (dto.matchId && conversation.matchId && dto.matchId !== conversation.matchId) {
        throw new BadRequestException({
          errorCode: ERROR_CODES.VALIDATION_ERROR,
          message: 'conversationId belongs to a different match',
        });
      }
      return conversation;
    }

    if (dto.matchId) await this.cvMatches.getGapReport(userId, dto.matchId);
    return this.conversations.save(
      this.conversations.create({
        userId,
        matchId: dto.matchId ?? null,
        title: dto.message.trim().slice(0, 80) || null,
      }),
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
}

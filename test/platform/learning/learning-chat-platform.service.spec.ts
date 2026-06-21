import { NotFoundException } from '@nestjs/common';
import { LearningChatPlatformService } from '../../../src/platform/learning/learning-chat-platform.service';

function repo() {
  return {
    create: jest.fn((input) => input),
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(),
    save: jest.fn(async (input) => ({ id: input.id ?? 'saved-id', ...input })),
  };
}

describe('LearningChatPlatformService', () => {
  function build() {
    const conversations = repo();
    const messages = repo();
    const chat = {
      turn: jest.fn(async () => ({
        message: 'Use Docker docs',
        cited_resources: [
          {
            resource_id: 'docker-docs',
            rank: 1,
            title: 'Docker',
            provider: 'Docker',
            source_type: 'official_doc',
            outcome_type: 'understand',
          },
        ],
        suggested_next_step: 'build a tiny container',
        retrieved: [],
      })),
    };
    const cvMatches = {
      getGapReport: jest.fn(async () => ({
        gap_items: [{ canonical_name: 'docker', cv_status: 'missing', severity: 0.8 }],
      })),
    };
    const tracing = {
      countRequestsSince: jest.fn(async () => 0),
      startAiRequest: jest.fn(async () => 'ai-req-1'),
      completeAiRequest: jest.fn(async () => undefined),
      markFailed: jest.fn(async () => undefined),
    };
    const svc = new LearningChatPlatformService(
      conversations as never,
      messages as never,
      chat as never,
      cvMatches as never,
      tracing as never,
    );
    return { svc, conversations, messages, chat, cvMatches, tracing };
  }

  it('creates an owned conversation, builds facts, calls ChatService, and persists both messages', async () => {
    const { svc, conversations, messages, chat, cvMatches, tracing } = build();
    conversations.save.mockResolvedValueOnce({
      id: 'conv-1',
      userId: 'user-1',
      matchId: 'match-1',
    });

    const out = await svc.turn('user-1', { message: 'toi hoc docker sao?', matchId: 'match-1' });

    expect(cvMatches.getGapReport).toHaveBeenCalledWith('user-1', 'match-1');
    expect(chat.turn).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'toi hoc docker sao?',
        facts: { open_gaps: [{ skill: 'docker', severity: 0.8, status: 'missing' }] },
      }),
    );
    expect(messages.save).toHaveBeenCalledTimes(2);
    expect(tracing.startAiRequest).toHaveBeenCalledWith(
      expect.objectContaining({ requestType: 'learning_chat' }),
    );
    expect(tracing.completeAiRequest).toHaveBeenCalledWith(
      'ai-req-1',
      expect.objectContaining({ status: 'SUCCESS' }),
    );
    expect(out.conversation_id).toBe('conv-1');
    expect(out.cited_resources.map((resource) => resource.resource_id)).toEqual(['docker-docs']);
  });

  it('does not return history for a conversation owned by someone else', async () => {
    const { svc, conversations } = build();
    conversations.findOne.mockResolvedValueOnce(null);

    await expect(svc.history('user-1', 'other-conv')).rejects.toBeInstanceOf(NotFoundException);
  });
});

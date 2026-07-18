import { HttpException } from '@nestjs/common';
import { IsNull } from 'typeorm';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { emptyCanonicalCv } from '../../common/types/canonical-cv';
import { CvBuilderChatPlatformService } from './cv-builder-chat-platform.service';
import { CvBuilderChatRequestDto } from './dto/cv-builder-chat.dto';

const USER_ID = 'user-1';
const CV_ID = '11111111-1111-1111-1111-111111111111';
const CONVERSATION_ID = 'conv-builder-1';

interface SavedMessage {
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  metadata: Record<string, unknown> | null;
}

interface FakeConversationRow {
  id: string;
  userId: string;
  cvId: string | null;
  matchId: string | null;
  purpose: string;
  title: string | null;
}

/**
 * Minimal in-memory conversations "table" so a purpose-keyed findOne genuinely filters — a diagnosis
 * row seeded here must NOT satisfy a query scoped to purpose='cv_builder'. FindOperator values
 * (only IsNull() is ever used on this entity) match any row field that is actually null.
 */
function makeConversationsRepo(seed: FakeConversationRow[] = []) {
  const rows: FakeConversationRow[] = [...seed];
  const findOne = jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
    return (
      rows.find((row) =>
        Object.entries(where).every(([key, value]) => {
          if (value && typeof value === 'object') return (row as never)[key] === null;
          return (row as never)[key] === value;
        }),
      ) ?? null
    );
  });
  const create = jest.fn((v: Partial<FakeConversationRow>) => v);
  const save = jest.fn(async (v: Partial<FakeConversationRow>) => {
    const row = { id: `conv-${rows.length + 1}`, title: null, ...v } as FakeConversationRow;
    rows.push(row);
    return row;
  });
  const del = jest.fn(async ({ id }: { id: string }) => {
    const idx = rows.findIndex((row) => row.id === id);
    if (idx >= 0) rows.splice(idx, 1);
    return { affected: idx >= 0 ? 1 : 0 };
  });
  return { findOne, create, save, delete: del, rows };
}

function makeService(overrides?: {
  conversations?: ReturnType<typeof makeConversationsRepo>;
  getOwnedCvForChat?: jest.Mock;
  turn?: jest.Mock;
  countRequestsSince?: jest.Mock;
  messagesFind?: jest.Mock;
}) {
  const saved: SavedMessage[] = [];
  const conversations = overrides?.conversations ?? makeConversationsRepo();

  const messages = {
    create: jest.fn((v: SavedMessage) => v),
    save: jest.fn((v: SavedMessage) => {
      saved.push(v);
      return Promise.resolve({ id: `msg-${saved.length}`, createdAt: new Date(), ...v });
    }),
    find: overrides?.messagesFind ?? jest.fn().mockResolvedValue([]),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
  };

  const chat = {
    turn:
      overrides?.turn ??
      jest.fn().mockResolvedValue({
        answer: 'Thêm một câu về kết quả nhé.',
        answer_kind: 'grounded',
        proposed_edit: null,
        grounded_facts: [],
        suggested_next_step: null,
      }),
  };

  const cvs = {
    getOwnedCvForChat:
      overrides?.getOwnedCvForChat ??
      jest.fn().mockResolvedValue({
        document: emptyCanonicalCv('vi'),
        targetRole: 'Backend Developer',
        language: 'vi',
      }),
  };

  const tracing = {
    countRequestsSince: overrides?.countRequestsSince ?? jest.fn().mockResolvedValue(0),
    startAiRequest: jest.fn().mockResolvedValue('ai-req-1'),
    completeAiRequest: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
  };

  const service = new CvBuilderChatPlatformService(
    conversations as never,
    messages as never,
    chat as never,
    cvs as never,
    tracing as never,
  );

  return { service, saved, conversations, messages, chat, cvs, tracing };
}

const DTO: CvBuilderChatRequestDto = { question: 'Mình nên viết mô tả dự án sao cho tốt?' };

describe('CvBuilderChatPlatformService.turn — purpose keying', () => {
  it('resolves a cv_builder-purpose conversation, distinct from a CV-only diagnosis thread on the same cvId', async () => {
    const diagnosisRow: FakeConversationRow = {
      id: 'conv-diagnosis-1',
      userId: USER_ID,
      cvId: CV_ID,
      matchId: null,
      purpose: 'diagnosis',
      title: null,
    };
    const conversations = makeConversationsRepo([diagnosisRow]);
    const { service } = makeService({ conversations });

    await service.turn(USER_ID, CV_ID, DTO);

    expect(conversations.findOne).toHaveBeenCalledWith({
      where: { userId: USER_ID, cvId: CV_ID, matchId: IsNull(), purpose: 'cv_builder' },
    });
    // The seeded diagnosis row must never be reused — a SEPARATE cv_builder row is created alongside it.
    expect(conversations.rows).toHaveLength(2);
    const builderRow = conversations.rows.find((r) => r.purpose === 'cv_builder');
    expect(builderRow).toBeDefined();
    expect(builderRow!.id).not.toBe(diagnosisRow.id);
  });

  it('reuses an existing cv_builder conversation instead of creating a second one', async () => {
    const builderRow: FakeConversationRow = {
      id: CONVERSATION_ID,
      userId: USER_ID,
      cvId: CV_ID,
      matchId: null,
      purpose: 'cv_builder',
      title: null,
    };
    const conversations = makeConversationsRepo([builderRow]);
    const { service } = makeService({ conversations });

    await service.turn(USER_ID, CV_ID, DTO);

    expect(conversations.create).not.toHaveBeenCalled();
    expect(conversations.rows).toHaveLength(1);
  });
});

describe('CvBuilderChatPlatformService — getThread/deleteThread purpose isolation', () => {
  function seedBothPurposes() {
    const diagnosisRow: FakeConversationRow = {
      id: 'conv-diagnosis-1',
      userId: USER_ID,
      cvId: CV_ID,
      matchId: null,
      purpose: 'diagnosis',
      title: null,
    };
    const builderRow: FakeConversationRow = {
      id: 'conv-builder-1',
      userId: USER_ID,
      cvId: CV_ID,
      matchId: null,
      purpose: 'cv_builder',
      title: null,
    };
    return {
      diagnosisRow,
      builderRow,
      conversations: makeConversationsRepo([diagnosisRow, builderRow]),
    };
  }

  it('getThread returns only the cv_builder thread turns, ignoring a diagnosis row seeded for the same (userId, cvId)', async () => {
    const { builderRow, conversations } = seedBothPurposes();
    const messagesFind = jest.fn().mockResolvedValue([
      {
        role: 'user',
        content: 'cv builder msg',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        metadata: null,
      },
    ]);
    const { service } = makeService({ conversations, messagesFind });

    const result = await service.getThread(USER_ID, CV_ID);

    expect(conversations.findOne).toHaveBeenCalledWith({
      where: { userId: USER_ID, cvId: CV_ID, matchId: IsNull(), purpose: 'cv_builder' },
    });
    expect(messagesFind).toHaveBeenCalledWith({
      where: { conversationId: builderRow.id },
      order: { createdAt: 'ASC' },
    });
    expect(result.turns).toEqual([
      { role: 'user', text: 'cv builder msg', ts: '2026-01-01T00:00:00.000Z' },
    ]);
  });

  it('deleteThread deletes only the cv_builder conversation — the diagnosis row for the same (userId, cvId) survives', async () => {
    const { diagnosisRow, builderRow, conversations } = seedBothPurposes();
    const { service } = makeService({ conversations });

    await service.deleteThread(USER_ID, CV_ID);

    expect(conversations.delete).toHaveBeenCalledWith({ id: builderRow.id });
    expect(conversations.rows.find((r) => r.id === builderRow.id)).toBeUndefined();
    expect(conversations.rows.find((r) => r.id === diagnosisRow.id)).toEqual(diagnosisRow);
  });
});

describe('CvBuilderChatPlatformService.turn — server-read target_role', () => {
  it('reads target_role server-side via getOwnedCvForChat; the DTO has no role field to inject', async () => {
    const getOwnedCvForChat = jest.fn().mockResolvedValue({
      document: emptyCanonicalCv('vi'),
      targetRole: 'Data Analyst',
      language: 'vi',
    });
    const { service, chat } = makeService({ getOwnedCvForChat });

    await service.turn(USER_ID, CV_ID, DTO);

    expect(getOwnedCvForChat).toHaveBeenCalledWith(USER_ID, CV_ID);
    const factsArg = (chat.turn as jest.Mock).mock.calls[0][0].facts;
    expect(factsArg.target_role).toBe('Data Analyst');
    // Nothing on the DTO could have supplied a role in the first place — it carries no such field.
    expect(Object.keys(DTO)).not.toContain('target_role');
  });
});

describe('CvBuilderChatPlatformService.turn — quota (429)', () => {
  it('at the daily limit → 429 FEATURE_USAGE_LIMIT_REACHED, no chat call, nothing persisted', async () => {
    const countRequestsSince = jest.fn().mockResolvedValue(50); // DAILY_CHAT_LIMIT
    const { service, chat, saved } = makeService({ countRequestsSince });

    let err: unknown;
    try {
      await service.turn(USER_ID, CV_ID, DTO);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect((err as HttpException).getResponse()).toMatchObject({
      errorCode: ERROR_CODES.FEATURE_USAGE_LIMIT_REACHED,
    });
    expect(chat.turn).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
  });
});

describe('CvBuilderChatPlatformService.turn — failure path', () => {
  it('a chat/LLM failure still calls markFailed and rethrows (no swallowed error)', async () => {
    const boom = new Error('llm transport boom');
    const turn = jest.fn().mockRejectedValue(boom);
    const { service, tracing, saved } = makeService({ turn });

    await expect(service.turn(USER_ID, CV_ID, DTO)).rejects.toBe(boom);
    expect(tracing.markFailed).toHaveBeenCalledWith('ai-req-1', expect.any(Number), boom);
    // The user row was persisted before the failure; no assistant row followed.
    expect(saved.filter((m) => m.role === 'assistant')).toHaveLength(0);
  });
});

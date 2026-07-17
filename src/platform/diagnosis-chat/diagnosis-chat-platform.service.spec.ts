import { Logger, NotFoundException } from '@nestjs/common';
import { IsNull } from 'typeorm';
import { DiagnosisChatPlatformService } from './diagnosis-chat-platform.service';
import { DiagnosisChatCvOnlyRequestDto, DiagnosisChatRequestDto } from './dto/diagnosis-chat.dto';

const USER_ID = 'user-1';
const MATCH_ID = 'match-1';
const CONVERSATION_ID = 'conv-1';
const CV_ID = '11111111-1111-1111-1111-111111111111';

const REVIEW = {
  overall_score: 70,
  ats_rule_score: 60,
  llm_score_dimensions: { skills_relevance: 12 },
  rationale: { skills_relevance: 'Some JD skills missing.' },
  top_summary: { prioritized_actions: ['Add Docker evidence'] },
} as never;

const GAP_REPORT = {
  gap_items: [
    {
      requirement_id: 'jd:hard_skill:docker',
      display_name: 'Docker',
      cv_status: 'missing',
      severity: 0.5,
      market_demand: 60,
      recommended_next_action: 'Học & bổ sung kỹ năng này',
    },
  ],
} as never;

interface SavedMessage {
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  metadata: Record<string, unknown> | null;
}

/**
 * Build the platform service with plain-object mocks at the IO boundary (mirrors the module spec's
 * positional-construction style). `saved` collects every persisted chat_messages row so a test can
 * assert what was actually written (e.g. the user row content is masked).
 */
function makeService(overrides?: {
  getGapReport?: jest.Mock;
  getReviewForMatch?: jest.Mock;
  getLatestReview?: jest.Mock;
  getProgress?: jest.Mock;
  listRecentMatchSummariesForUser?: jest.Mock;
  turn?: jest.Mock;
  conversationFindOne?: jest.Mock;
  conversationDelete?: jest.Mock;
  messagesFind?: jest.Mock;
  messagesDelete?: jest.Mock;
}) {
  const saved: SavedMessage[] = [];

  const conversations = {
    findOne:
      overrides?.conversationFindOne ??
      jest.fn().mockResolvedValue({ id: CONVERSATION_ID, userId: USER_ID, matchId: MATCH_ID }),
    create: jest.fn((v) => v),
    save: jest.fn((v) => Promise.resolve({ id: CONVERSATION_ID, ...v })),
    delete: overrides?.conversationDelete ?? jest.fn().mockResolvedValue({ affected: 1 }),
  };

  const messages = {
    create: jest.fn((v: SavedMessage) => v),
    save: jest.fn((v: SavedMessage) => {
      saved.push(v);
      return Promise.resolve({ id: `msg-${saved.length}`, ...v });
    }),
    find: overrides?.messagesFind ?? jest.fn().mockResolvedValue([]),
    delete: overrides?.messagesDelete ?? jest.fn().mockResolvedValue({ affected: 1 }),
  };

  const chat = {
    turn:
      overrides?.turn ??
      jest.fn().mockResolvedValue({
        answer: 'Focus on skills_relevance.',
        answer_kind: 'grounded',
        cited_dimension: 'skills_relevance',
        cited_gap_id: 'jd:hard_skill:docker',
        suggested_next_step: null,
      }),
  };

  const cvMatches = {
    getGapReport: overrides?.getGapReport ?? jest.fn().mockResolvedValue(GAP_REPORT),
    getReviewForMatch: overrides?.getReviewForMatch ?? jest.fn().mockResolvedValue(REVIEW),
    getProgress: overrides?.getProgress ?? jest.fn().mockResolvedValue(null),
    listRecentMatchSummariesForUser:
      overrides?.listRecentMatchSummariesForUser ?? jest.fn().mockResolvedValue([]),
  };

  const cvs = {
    getLatestReview: overrides?.getLatestReview ?? jest.fn().mockResolvedValue(REVIEW),
  };

  const tracing = {
    countRequestsSince: jest.fn().mockResolvedValue(0),
    startAiRequest: jest.fn().mockResolvedValue('ai-req-1'),
    completeAiRequest: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
  };

  const service = new DiagnosisChatPlatformService(
    conversations as never,
    messages as never,
    chat as never,
    cvMatches as never,
    cvs as never,
    tracing as never,
  );

  return { service, saved, conversations, messages, chat, cvMatches, cvs, tracing };
}

describe('DiagnosisChatPlatformService.turn — PII (D1)', () => {
  it('persists the user message MASKED (no raw email/phone in chat_messages content)', async () => {
    const { service, saved, chat } = makeService();
    const dto: DiagnosisChatRequestDto = {
      question: 'Liên hệ tôi qua taithi@skillbridge.vn hoặc 0901234567 nhé',
      cvId: CV_ID,
    };

    await service.turn(USER_ID, MATCH_ID, dto);

    const userRow = saved.find((m) => m.role === 'user');
    expect(userRow).toBeDefined();
    // The persisted user row must be masked — raw PII must never land in the audit/history store.
    expect(userRow!.content).not.toContain('taithi@skillbridge.vn');
    expect(userRow!.content).not.toContain('0901234567');
    expect(userRow!.content).toContain('[redacted-email]');
    expect(userRow!.content).toContain('[redacted-phone]');

    // And the LLM-bound copy is masked too (same masked value used for both).
    const turnArg = (chat.turn as jest.Mock).mock.calls[0][0];
    expect(turnArg.question).not.toContain('taithi@skillbridge.vn');
    expect(turnArg.question).toBe(userRow!.content);
  });
});

describe('DiagnosisChatPlatformService.turn — ownership/error masking (D2)', () => {
  it('(a) getGapReport throws NotFound AND no cvId → rejects NotFound (no degraded answer)', async () => {
    const getGapReport = jest.fn().mockRejectedValue(new NotFoundException('CV match not found'));
    const { service, saved } = makeService({ getGapReport });
    const dto: DiagnosisChatRequestDto = { question: 'where am I weakest?' }; // no cvId

    await expect(service.turn(USER_ID, MATCH_ID, dto)).rejects.toBeInstanceOf(NotFoundException);
    // It must NOT have produced/persisted an assistant answer via the CV-only path.
    expect(saved.find((m) => m.role === 'assistant')).toBeUndefined();
  });

  it('(b) getGapReport throws a generic (transient) Error → rethrows it (not swallowed to CV-only)', async () => {
    const transient = new Error('db connection reset');
    const getGapReport = jest.fn().mockRejectedValue(transient);
    const getLatestReview = jest.fn().mockResolvedValue(REVIEW);
    const { service } = makeService({ getGapReport, getLatestReview });
    const dto: DiagnosisChatRequestDto = { question: 'q', cvId: CV_ID };

    await expect(service.turn(USER_ID, MATCH_ID, dto)).rejects.toBe(transient);
    // The transient error must surface — the CV-only fallback must NOT mask it.
    expect(getLatestReview).not.toHaveBeenCalled();
  });

  it('(c) getGapReport throws NotFound EVEN with cvId → rejects NotFound (match route is fail-closed)', async () => {
    const getGapReport = jest.fn().mockRejectedValue(new NotFoundException('CV match not found'));
    const getLatestReview = jest.fn().mockResolvedValue(REVIEW);
    const { service, chat, saved } = makeService({ getGapReport, getLatestReview });
    const dto: DiagnosisChatRequestDto = { question: 'q', cvId: CV_ID };

    await expect(service.turn(USER_ID, MATCH_ID, dto)).rejects.toBeInstanceOf(NotFoundException);
    expect(getLatestReview).not.toHaveBeenCalled();
    expect(chat.turn).not.toHaveBeenCalled();
    expect(saved.find((m) => m.role === 'assistant')).toBeUndefined();
  });

  it('match route ignores client cvId and uses the review for the owned match cv only', async () => {
    const getReviewForMatch = jest.fn().mockResolvedValue(REVIEW);
    const getLatestReview = jest.fn().mockResolvedValue({
      ...(REVIEW as object),
      llm_score_dimensions: { skills_relevance: 1 },
    });
    const { service, chat } = makeService({ getReviewForMatch, getLatestReview });

    await service.turn(USER_ID, MATCH_ID, { question: 'q', cvId: CV_ID });

    expect(getReviewForMatch).toHaveBeenCalledWith(USER_ID, MATCH_ID);
    expect(getLatestReview).not.toHaveBeenCalled();
    const factsArg = (chat.turn as jest.Mock).mock.calls[0][0].facts;
    expect(factsArg.dimensions).toEqual([
      { key: 'skills_relevance', score20: 12, rationale: 'Some JD skills missing.' },
    ]);
  });

  it('progress load failing (best-effort) → chat facts still built, NO progress key, degradation is WARN-logged (not silent)', async () => {
    const getProgress = jest.fn().mockRejectedValue(new Error('progress lookup boom'));
    const { service, chat } = makeService({ getProgress });
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const res = await service.turn(USER_ID, MATCH_ID, { question: 'q', cvId: CV_ID });

    expect(res.answer).toBeDefined();
    expect(getProgress).toHaveBeenCalledWith(USER_ID, MATCH_ID);
    const factsArg = (chat.turn as jest.Mock).mock.calls[0][0].facts;
    expect(factsArg).not.toHaveProperty('progress');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('progress lookup failed'));
    warn.mockRestore();
  });

  it('answer_kind rides the wire to the FE (Wave 1 mascot pose)', async () => {
    const { service } = makeService();
    const res = await service.turn(USER_ID, MATCH_ID, { question: 'q', cvId: CV_ID });
    expect(res.answer_kind).toBe('grounded');
  });

  it('adds recent other match summaries to facts for cross-JD comparison', async () => {
    const listRecentMatchSummariesForUser = jest.fn().mockResolvedValue([
      {
        jd_title: 'Frontend Developer',
        overall_score: 72,
        top_gaps: ['React', 'TypeScript'],
        created_at: '2026-07-02T08:00:00.000Z',
      },
    ]);
    const { service, chat } = makeService({ listRecentMatchSummariesForUser });

    await service.turn(USER_ID, MATCH_ID, { question: 'JD nào hợp tôi hơn?', cvId: CV_ID });

    expect(listRecentMatchSummariesForUser).toHaveBeenCalledWith(USER_ID, MATCH_ID);
    const factsArg = (chat.turn as jest.Mock).mock.calls[0][0].facts;
    expect(factsArg.other_matches).toEqual([
      {
        jd_title: 'Frontend Developer',
        overall_score: 72,
        top_gaps: ['React', 'TypeScript'],
      },
    ]);
  });

  it('recent other-match lookup failure is best-effort, does not break chat, and is WARN-logged (not silent)', async () => {
    const listRecentMatchSummariesForUser = jest
      .fn()
      .mockRejectedValue(new Error('summary lookup boom'));
    const { service, chat } = makeService({ listRecentMatchSummariesForUser });
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const res = await service.turn(USER_ID, MATCH_ID, { question: 'q', cvId: CV_ID });

    expect(res.answer).toBeDefined();
    expect(listRecentMatchSummariesForUser).toHaveBeenCalledWith(USER_ID, MATCH_ID);
    const factsArg = (chat.turn as jest.Mock).mock.calls[0][0].facts;
    expect(factsArg).not.toHaveProperty('other_matches');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('other-matches lookup failed'));
    warn.mockRestore();
  });

  it('maps a valid cited_other_match_index from grounding into response.cited_match with real deep-linkable ids (M1)', async () => {
    const listRecentMatchSummariesForUser = jest.fn().mockResolvedValue([
      {
        match_id: 'match-other-1',
        cv_id: 'cv-other-1',
        jd_title: 'Frontend Developer',
        overall_score: 72,
        top_gaps: ['React', 'TypeScript'],
        created_at: '2026-07-02T08:00:00.000Z',
      },
    ]);
    const turn = jest.fn().mockResolvedValue({
      answer: 'The frontend JD looks best for you.',
      cited_other_match_index: 1,
    });
    const { service } = makeService({ listRecentMatchSummariesForUser, turn });

    const res = await service.turn(USER_ID, MATCH_ID, {
      question: 'JD nào hợp tôi hơn?',
      cvId: CV_ID,
    });

    expect(res.cited_match).toEqual({
      match_id: 'match-other-1',
      cv_id: 'cv-other-1',
      jd_title: 'Frontend Developer',
    });
  });

  it('omits response.cited_match when grounding did not cite a valid other-match index (M1)', async () => {
    const listRecentMatchSummariesForUser = jest.fn().mockResolvedValue([
      {
        match_id: 'match-other-1',
        cv_id: 'cv-other-1',
        jd_title: 'Frontend Developer',
        overall_score: 72,
        top_gaps: ['React'],
        created_at: '2026-07-02T08:00:00.000Z',
      },
    ]);
    const turn = jest.fn().mockResolvedValue({ answer: 'ok' }); // no cited_other_match_index
    const { service } = makeService({ listRecentMatchSummariesForUser, turn });

    const res = await service.turn(USER_ID, MATCH_ID, { question: 'q', cvId: CV_ID });

    expect(res.cited_match).toBeUndefined();
  });

  it('forwards cited_tool from grounding onto the wire response — LIVE BUG fix: was dropped before this task (M1)', async () => {
    const turn = jest.fn().mockResolvedValue({
      answer: 'Verified via GitHub.',
      cited_tool: 'github.enrich',
    });
    const { service } = makeService({ turn });

    const res = await service.turn(USER_ID, MATCH_ID, { question: 'q', cvId: CV_ID });

    expect(res.cited_tool).toBe('github.enrich');
  });
});

describe('DiagnosisChatPlatformService.turnCvOnly — CV-only route (no JD match)', () => {
  it('builds facts from the review (gap_items []), keys the conversation by (userId, cvId), persists, returns a grounded answer', async () => {
    // No existing conversation → it must be CREATED scoped to (userId, cvId), matchId null.
    const conversationFindOne = jest.fn().mockResolvedValue(null);
    const getLatestReview = jest.fn().mockResolvedValue(REVIEW);
    const { service, saved, conversations, chat, cvMatches } = makeService({
      conversationFindOne,
      getLatestReview,
    });
    const dto: DiagnosisChatCvOnlyRequestDto = { question: 'where is my CV weakest?' };

    const res = await service.turnCvOnly(USER_ID, CV_ID, dto);

    expect(res.answer).toBeDefined();
    // CV-only path NEVER touches the JD-match gap report.
    expect((cvMatches.getGapReport as jest.Mock | undefined) ?? jest.fn()).toBeDefined();
    // Facts come from the review; the CV-only path yields NO gap_items.
    expect(getLatestReview).toHaveBeenCalledWith(USER_ID, CV_ID);
    const factsArg = (chat.turn as jest.Mock).mock.calls[0][0].facts;
    expect(factsArg.gap_items).toEqual([]);

    // Conversation keyed by (userId, cvId) with matchId null — must NOT collide with a JD chat for the same CV.
    expect(conversationFindOne).toHaveBeenCalledWith({
      where: { userId: USER_ID, cvId: CV_ID, matchId: IsNull() },
    });
    const createdConversation = (conversations.create as jest.Mock).mock.calls[0][0];
    expect(createdConversation).toMatchObject({ userId: USER_ID, cvId: CV_ID, matchId: null });

    // Persisted both the user + assistant rows; the user row carries cv_id (not match_id) in metadata.
    const userRow = saved.find((m) => m.role === 'user');
    const assistantRow = saved.find((m) => m.role === 'assistant');
    expect(userRow).toBeDefined();
    expect(assistantRow).toBeDefined();
    expect(userRow!.metadata).toMatchObject({ cv_id: CV_ID });
  });

  it('reuses an existing (userId, cvId) conversation instead of creating a new one', async () => {
    const existing = { id: CONVERSATION_ID, userId: USER_ID, cvId: CV_ID, matchId: null };
    const conversationFindOne = jest.fn().mockResolvedValue(existing);
    const getLatestReview = jest.fn().mockResolvedValue(REVIEW);
    const { service, conversations } = makeService({ conversationFindOne, getLatestReview });

    await service.turnCvOnly(USER_ID, CV_ID, { question: 'q' });

    // Found an existing thread → must NOT create a second conversation row.
    expect(conversations.create).not.toHaveBeenCalled();
  });

  it('ownership: a cvId not owned by the user → getLatestReview null → clean NotFound (no cross-user data, no crash)', async () => {
    const conversationFindOne = jest.fn().mockResolvedValue(null);
    const getLatestReview = jest.fn().mockResolvedValue(null); // not owned / no review
    const { service, saved } = makeService({ conversationFindOne, getLatestReview });

    await expect(service.turnCvOnly(USER_ID, CV_ID, { question: 'q' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // No assistant answer must have been produced/persisted for a non-owned CV.
    expect(saved.find((m) => m.role === 'assistant')).toBeUndefined();
  });
});

describe('DiagnosisChatPlatformService — visible trust wire (Wave 2)', () => {
  it('grounded_facts ride the wire; an other_match index is swapped for the real match_id', async () => {
    const listRecentMatchSummariesForUser = jest.fn().mockResolvedValue([
      {
        match_id: 'match-other-1',
        cv_id: 'cv-other-1',
        jd_title: 'Frontend Developer',
        overall_score: 72,
        top_gaps: ['React'],
        created_at: '2026-07-02T08:00:00.000Z',
      },
    ]);
    const turn = jest.fn().mockResolvedValue({
      answer: 'ok',
      answer_kind: 'grounded',
      grounded_facts: [
        { kind: 'gap', id: 'jd:hard_skill:docker', label: 'Docker' },
        { kind: 'other_match', id: '1', label: 'Frontend Developer' },
      ],
    });
    const { service } = makeService({ listRecentMatchSummariesForUser, turn });
    const res = await service.turn(USER_ID, MATCH_ID, { question: 'q', cvId: CV_ID });
    expect(res.grounded_facts).toEqual([
      { kind: 'gap', id: 'jd:hard_skill:docker', label: 'Docker' },
      { kind: 'other_match', id: 'match-other-1', label: 'Frontend Developer' },
    ]);
  });

  it('an other_match fact with no matching summary is DROPPED — never served with a raw index id', async () => {
    const turn = jest.fn().mockResolvedValue({
      answer: 'ok',
      answer_kind: 'grounded',
      grounded_facts: [{ kind: 'other_match', id: '3', label: 'Gone JD' }],
    });
    const { service } = makeService({ turn }); // no summaries (CV-only style)
    const res = await service.turn(USER_ID, MATCH_ID, { question: 'q', cvId: CV_ID });
    expect(res.grounded_facts).toBeUndefined();
  });

  it('known_state rides the wire verbatim', async () => {
    const turn = jest.fn().mockResolvedValue({
      answer: 'ok',
      answer_kind: 'grounded',
      grounded_facts: [],
      known_state: { target_role: 'Data Analyst', deadline: '2 tuần', covered_gaps: ['Docker'] },
    });
    const { service } = makeService({ turn });
    const res = await service.turn(USER_ID, MATCH_ID, { question: 'q', cvId: CV_ID });
    expect(res.known_state).toEqual({
      target_role: 'Data Analyst',
      deadline: '2 tuần',
      covered_gaps: ['Docker'],
    });
  });

  it('getThread rebuilds known_state from the persisted rows (covered_gaps empty — no facts at restore)', async () => {
    const rows = [
      {
        role: 'user',
        content: 'Mình nhắm vị trí AI Engineer nhé',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        role: 'assistant',
        content: 'Ghi nhận nhé.',
        createdAt: new Date('2026-01-01T00:01:00.000Z'),
      },
    ];
    const messagesFind = jest.fn().mockResolvedValue(rows);
    const { service } = makeService({ messagesFind });
    const result = await service.getThread(USER_ID, MATCH_ID);
    expect(result.known_state).toEqual({
      target_role: 'AI Engineer',
      deadline: null,
      covered_gaps: [],
    });
  });
});

describe('DiagnosisChatPlatformService thread endpoints (MB1)', () => {
  it('returns persisted turns ASC for owned conversation', async () => {
    const rows = Array.from({ length: 42 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message-${i + 1}`,
      createdAt: new Date(`2026-01-01T00:${String(i).padStart(2, '0')}:00.000Z`),
    }));
    const messagesFind = jest.fn().mockResolvedValue(rows);
    const { service } = makeService({ messagesFind });

    const result = await service.getThread(USER_ID, MATCH_ID);

    expect(messagesFind).toHaveBeenCalledWith({
      where: { conversationId: CONVERSATION_ID },
      order: { createdAt: 'ASC' },
    });
    expect(result.turns).toHaveLength(40);
    expect(result.turns[0]).toEqual({
      role: 'user',
      text: 'message-3',
      ts: '2026-01-01T00:02:00.000Z',
    });
    expect(result.turns[39]).toEqual({
      role: 'assistant',
      text: 'message-42',
      ts: '2026-01-01T00:41:00.000Z',
    });
  });

  it('returns empty turns when no conversation exists', async () => {
    const conversationFindOne = jest.fn().mockResolvedValue(null);
    const messagesFind = jest.fn();
    const { service, conversations } = makeService({ conversationFindOne, messagesFind });

    await expect(service.getThread(USER_ID, MATCH_ID)).resolves.toEqual({ turns: [] });

    expect(conversationFindOne).toHaveBeenCalledWith({
      where: { userId: USER_ID, matchId: MATCH_ID },
    });
    expect(messagesFind).not.toHaveBeenCalled();
    expect(conversations.create).not.toHaveBeenCalled();
    expect(conversations.save).not.toHaveBeenCalled();
  });

  it('deleteThread deletes messages then conversation', async () => {
    const messagesDelete = jest.fn().mockResolvedValue({ affected: 2 });
    const conversationDelete = jest.fn().mockResolvedValue({ affected: 1 });
    const { service } = makeService({ messagesDelete, conversationDelete });

    await service.deleteThread(USER_ID, MATCH_ID);

    expect(messagesDelete).toHaveBeenCalledWith({ conversationId: CONVERSATION_ID });
    expect(conversationDelete).toHaveBeenCalledWith({ id: CONVERSATION_ID });
    expect(messagesDelete.mock.invocationCallOrder[0]).toBeLessThan(
      conversationDelete.mock.invocationCallOrder[0],
    );
  });
});

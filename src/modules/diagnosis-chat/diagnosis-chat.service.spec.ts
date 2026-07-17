import { ServiceUnavailableException } from '@nestjs/common';
import { DiagnosisChatService } from './diagnosis-chat.service';
import { DiagnosisFacts } from './diagnosis-grounding';

const FACTS: DiagnosisFacts = {
  overall_score: 70,
  ats_score: 60,
  dimensions: [{ key: 'skills_relevance', score20: 12, rationale: 'Some JD skills missing.' }],
  top_summary: { prioritized_actions: ['Add Docker evidence', 'Quantify the API bullet'] },
  gap_items: [
    {
      requirement_id: 'jd:hard_skill:docker',
      display_name: 'Docker',
      cv_status: 'missing',
      severity: 0.5,
      market_demand: 60,
      recommended_next_action: 'Học & bổ sung kỹ năng này',
      fixability: 'learn',
    },
  ],
};

function makeService(
  llmComplete: jest.Mock,
  registry: unknown = { invoke: jest.fn() },
): DiagnosisChatService {
  const prompts = {
    render: jest.fn().mockReturnValue('rendered-user-prompt'),
    // Code-aware: the service reads the RULES from the chat prompt's frontmatter and the
    // PERSONA from the character sheet's body (Wave 1) — two separate layers.
    get: jest.fn((code: string) =>
      code === 'mascot_character_v1'
        ? { body: 'Nhân cách cá heo SkillBridge — Thẳng mà ấm.', meta: {} }
        : { body: '', meta: { system: 'system-prompt' } },
    ),
  };
  // positional construction (llm, prompts, registry) — all mocked.
  return new DiagnosisChatService(
    { complete: llmComplete } as never,
    prompts as never,
    registry as never,
  );
}

describe('DiagnosisChatService.turn', () => {
  it('passes a valid LLM answer through groundDiagnosis (citations kept when in-facts)', async () => {
    const complete = jest.fn().mockResolvedValue({
      parsedJson: {
        message: 'Your ATS is 98 and Kubernetes is required.',
        cited_dimension: 'skills_relevance',
        cited_gap_id: 'jd:hard_skill:docker',
        suggested_next_step: 'Learn Kubernetes.',
      },
      text: '',
      tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      latencyMs: 123,
      modelCode: 'gemini-test',
      estimatedCostUsd: 0.001,
    });
    const service = makeService(complete);
    const result = await service.turn({ question: 'where am I weakest?', facts: FACTS });
    // The fabricated "98" kills the prose → Phase A refusal: warm copy + the cited gap as the
    // verified hook (gap outranks dimension), never the old fact template.
    expect(result.answer).toContain('dữ liệu đã xác minh');
    expect(result.answer).toContain('Docker');
    expect(result.answer).not.toContain('98');
    expect(result.answer).not.toContain('Kubernetes');
    expect(result.cited_dimension).toBe('skills_relevance');
    expect(result.cited_gap_id).toBe('jd:hard_skill:docker');
    expect(result.trace).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      latencyMs: 123,
      modelCode: 'gemini-test',
      estimatedCostUsd: 0.001,
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('LLM throw → deterministic grounded fallback (no 500, sourced from top_summary)', async () => {
    const complete = jest.fn().mockRejectedValue(new ServiceUnavailableException('LLM down'));
    const service = makeService(complete);
    const result = await service.turn({ question: 'help', facts: FACTS });
    expect(result.answer).toContain('Add Docker evidence');
    expect(result.cited_dimension).toBeUndefined();
    expect(result.cited_gap_id).toBeUndefined();
  });

  it('empty/garbage LLM output → fallback (drops fabricated citations)', async () => {
    const complete = jest.fn().mockResolvedValue({ parsedJson: null, text: 'not json' });
    const service = makeService(complete);
    const result = await service.turn({ question: 'help', facts: FACTS });
    expect(result.answer).toContain('Add Docker evidence');
  });

  it('drops an out-of-facts cited_dimension the model invents', async () => {
    const complete = jest.fn().mockResolvedValue({
      parsedJson: { message: 'ok', cited_dimension: 'charisma' },
      text: '',
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      latencyMs: 1,
      modelCode: 'test',
    });
    const service = makeService(complete);
    const result = await service.turn({ question: 'q', facts: FACTS });
    // The invented citation is dropped; the prose itself is still served (Advisor v3).
    expect(result.cited_dimension).toBeUndefined();
    expect(result.answer).toBe('ok');
  });
});

describe('DiagnosisChatService.turn — conversation brain (Phase B)', () => {
  it('a greeting is answered by CODE — the LLM is never called', async () => {
    const complete = jest.fn();
    const service = makeService(complete);
    const result = await service.turn({ question: 'chào bạn', facts: FACTS });
    expect(complete).not.toHaveBeenCalled();
    expect(result.answer).toContain('chẩn đoán CV');
    expect(result.suggested_next_step).toBeNull();
  });

  it('a greeting carrying a real question is NOT canned — it reaches the LLM', async () => {
    const complete = jest.fn().mockResolvedValue({
      parsedJson: { message: 'ok' },
      text: '',
      tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      latencyMs: 1,
      modelCode: 'test',
    });
    const service = makeService(complete);
    const result = await service.turn({ question: 'chào bạn, CV mình sao rồi', facts: FACTS });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.answer).toBe('ok');
  });

  it('system prompt = base rules + character sheet persona, in that order (Wave 1)', async () => {
    const complete = jest.fn().mockResolvedValue({
      parsedJson: { message: 'ok' },
      text: '',
      tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      latencyMs: 1,
      modelCode: 'test',
    });
    const service = makeService(complete);
    await service.turn({ question: 'nên làm gì trước?', facts: FACTS });
    const system = (complete.mock.calls[0][0] as Array<{ content: string }>)[0].content;
    expect(system).toContain('system-prompt');
    expect(system).toContain('Thẳng mà ấm');
    expect(system.indexOf('system-prompt')).toBeLessThan(system.indexOf('Thẳng mà ấm'));
  });

  it('canned greeting carries answer_kind=canned; a grounded turn carries grounded (Wave 1)', async () => {
    const complete = jest.fn().mockResolvedValue({
      parsedJson: { message: 'Bạn nên sửa bullet cho có số liệu trước.' },
      text: '',
      tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      latencyMs: 1,
      modelCode: 'test',
    });
    const service = makeService(complete);
    const canned = await service.turn({ question: 'chào bạn', facts: FACTS });
    expect(canned.answer_kind).toBe('canned');
    expect(complete).not.toHaveBeenCalled();
    const grounded = await service.turn({ question: 'nên làm gì trước?', facts: FACTS });
    expect(grounded.answer_kind).toBe('grounded');
  });

  it('threads the context block into the prompt: a role stated 30 messages ago is still Known, and no ask is issued for it', async () => {
    const complete = jest.fn().mockResolvedValue({
      parsedJson: { message: 'ok' },
      text: '',
      tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      latencyMs: 1,
      modelCode: 'test',
    });
    const prompts = {
      render: jest.fn().mockReturnValue('rendered-user-prompt'),
      get: jest.fn().mockReturnValue({ body: '', meta: { system: 'system-prompt' } }),
    };
    const service = new DiagnosisChatService(
      { complete } as never,
      prompts as never,
      { invoke: jest.fn() } as never,
    );
    const history = [
      { role: 'user' as const, content: 'Mình nhắm vị trí AI Engineer nhé' },
      ...Array.from({ length: 30 }, (_, i) => ({
        role: 'assistant' as const,
        content: `trả lời ${i}`,
      })),
    ];
    await service.turn({ question: 'giờ nên sửa gì trước?', facts: FACTS, history });
    const vars = prompts.render.mock.calls[0][1] as Record<string, string>;
    expect(vars.context).toContain('Target role: AI Engineer');
    expect(vars.context).not.toContain('asking which role');
    // The prompt transcript window stays bounded even though the state window is wider.
    expect(vars.history.split('\n').length).toBeLessThanOrEqual(10);
  });

  it('with no role stated anywhere, an advice question carries the ask-role directive', async () => {
    const complete = jest.fn().mockResolvedValue({
      parsedJson: { message: 'ok' },
      text: '',
      tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      latencyMs: 1,
      modelCode: 'test',
    });
    const prompts = {
      render: jest.fn().mockReturnValue('rendered-user-prompt'),
      get: jest.fn().mockReturnValue({ body: '', meta: { system: 'system-prompt' } }),
    };
    const service = new DiagnosisChatService(
      { complete } as never,
      prompts as never,
      { invoke: jest.fn() } as never,
    );
    const result = await service.turn({
      question: 'mình không biết bắt đầu từ đâu luôn',
      facts: FACTS,
    });
    const vars = prompts.render.mock.calls[0][1] as Record<string, string>;
    expect(vars.context).toContain('ONE short question asking which role');
    // The model's answer ('ok') dropped the ordered question → the backstop appends it.
    expect(result.answer).toContain('nhắm vị trí nào');
    expect(result.answer.includes('?')).toBe(true);
  });
});

describe('DiagnosisChatService.turn — known_state mirror (Wave 2)', () => {
  const HISTORY = [
    { role: 'user' as const, content: 'Mình nhắm vị trí Data Analyst nhé' },
    { role: 'user' as const, content: 'mình còn đúng 2 tuần nữa' },
    { role: 'assistant' as const, content: 'Docker đang là gap ưu tiên của bạn.' },
  ];
  const llmOk = () =>
    jest.fn().mockResolvedValue({
      parsedJson: { message: 'ok' },
      text: '',
      tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      latencyMs: 1,
      modelCode: 'test',
    });

  it('a grounded turn mirrors the deterministic state back — role, deadline, covered gaps', async () => {
    const service = makeService(llmOk());
    const result = await service.turn({
      question: 'giờ nên làm gì?',
      facts: FACTS,
      history: HISTORY,
    });
    expect(result.known_state).toEqual({
      target_role: 'Data Analyst',
      deadline: '2 tuần nữa',
      covered_gaps: ['Docker'],
    });
  });

  it('a canned turn carries the same mirror (and empty grounded_facts)', async () => {
    const complete = jest.fn();
    const service = makeService(complete);
    const result = await service.turn({ question: 'chào bạn', facts: FACTS, history: HISTORY });
    expect(complete).not.toHaveBeenCalled();
    expect(result.answer_kind).toBe('canned');
    expect(result.grounded_facts).toEqual([]);
    expect(result.known_state?.target_role).toBe('Data Analyst');
  });

  it('the LLM-failure fallback still mirrors state — the FE card never blanks on a bad turn', async () => {
    const complete = jest.fn().mockRejectedValue(new Error('LLM down'));
    const service = makeService(complete);
    const result = await service.turn({
      question: 'giờ nên làm gì?',
      facts: FACTS,
      history: HISTORY,
    });
    expect(result.known_state?.target_role).toBe('Data Analyst');
    expect(result.known_state?.deadline).toBe('2 tuần nữa');
  });

  it('nothing known → nulls and empty list, never a missing field', async () => {
    const service = makeService(llmOk());
    const result = await service.turn({ question: 'giờ nên làm gì?', facts: FACTS });
    expect(result.known_state).toEqual({ target_role: null, deadline: null, covered_gaps: [] });
  });
});

describe('DiagnosisChatService.turn — tool loop', () => {
  it('when userId is present and the decision call proposes github.enrich, merges tool facts before the final call', async () => {
    const complete = jest
      .fn()
      // call #1 (decision, tools) — proposes a tool call
      .mockResolvedValueOnce({
        text: '',
        toolCalls: [{ name: 'github.enrich', args: { username: 'octocat' } }],
      })
      // call #2 (final, schema) — v2 serves this verified prose, so it must look like a real answer
      .mockResolvedValueOnce({
        parsedJson: {
          message: 'GitHub của bạn tồn tại nhưng chưa có repo công khai nào về React.',
          cited_dimension: null,
          cited_gap_id: null,
          cited_other_match_index: null,
          cited_tool: 'github.enrich',
        },
        text: '',
        tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        latencyMs: 1,
        modelCode: 'test',
      });
    const invoke = jest
      .fn()
      .mockResolvedValue({ exists: true, public_repos: [], recent_activity_days: 1 });
    const service = makeService(complete, { invoke });
    const result = await service.turn({
      question: 'does my github show react?',
      facts: FACTS,
      userId: 'u1',
      aiRequestId: 'req-1',
    });
    expect(invoke).toHaveBeenCalledWith(
      'diagnosis_chat',
      'github.enrich',
      { username: 'octocat' },
      {
        userId: 'u1',
        aiRequestId: 'req-1',
        turnText: 'does my github show react?',
      },
    );
    expect(result.answer).toContain('GitHub');
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('no userId → tool loop skipped entirely, single call as before', async () => {
    const complete = jest.fn().mockResolvedValue({
      parsedJson: {
        message: 'ok',
        cited_dimension: 'skills_relevance',
        cited_gap_id: null,
        cited_other_match_index: null,
        cited_tool: null,
      },
      text: '',
      tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      latencyMs: 1,
      modelCode: 'test',
    });
    const invoke = jest.fn();
    const service = makeService(complete, { invoke });
    await service.turn({ question: 'q', facts: FACTS });
    expect(invoke).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('userId present but off-topic question → pre-gate skips the tool-decision call entirely', async () => {
    const complete = jest.fn().mockResolvedValue({
      parsedJson: {
        message: 'ok',
        cited_dimension: 'skills_relevance',
        cited_gap_id: null,
        cited_other_match_index: null,
        cited_tool: null,
      },
      text: '',
      tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      latencyMs: 1,
      modelCode: 'test',
    });
    const invoke = jest.fn();
    const service = makeService(complete, { invoke });
    await service.turn({ question: 'why is my score low?', facts: FACTS, userId: 'u1' });
    expect(invoke).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

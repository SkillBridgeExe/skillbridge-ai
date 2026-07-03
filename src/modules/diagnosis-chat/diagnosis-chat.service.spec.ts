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
    },
  ],
};

function makeService(
  llmComplete: jest.Mock,
  registry: unknown = { invoke: jest.fn() },
): DiagnosisChatService {
  const prompts = {
    render: jest.fn().mockReturnValue('rendered-user-prompt'),
    get: jest.fn().mockReturnValue({ meta: { system: 'system-prompt' } }),
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
    expect(result.answer).toContain('skills_relevance');
    expect(result.answer).toContain('12/20');
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
    expect(result.answer).toContain('Add Docker evidence');
    expect(result.cited_dimension).toBeUndefined();
  });
});

describe('DiagnosisChatService.turn — tool loop', () => {
  it('when userId is present and the decision call proposes github.enrich, merges tool facts before the final call', async () => {
    const complete = jest
      .fn()
      // call #1 (decision, tools) — proposes a tool call
      .mockResolvedValueOnce({ text: '', toolCalls: [{ name: 'github.enrich', args: { username: 'octocat' } }] })
      // call #2 (final, schema)
      .mockResolvedValueOnce({
        parsedJson: {
          message: 'ok',
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
    const invoke = jest.fn().mockResolvedValue({ exists: true, public_repos: [], recent_activity_days: 1 });
    const service = makeService(complete, { invoke });
    const result = await service.turn({
      question: 'does my github show react?',
      facts: FACTS,
      userId: 'u1',
      aiRequestId: 'req-1',
    });
    expect(invoke).toHaveBeenCalledWith('diagnosis_chat', 'github.enrich', { username: 'octocat' }, {
      userId: 'u1',
      aiRequestId: 'req-1',
    });
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
});

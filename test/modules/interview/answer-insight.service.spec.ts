import { AnswerInsightService } from '../../../src/modules/interview/answer-insight.service';
import { analyzeAnswerSignals } from '../../../src/modules/interview/answer-analyzer';

const SIGNALS = analyzeAnswerSignals({
  answer:
    'When the checkout page was slow, I implemented a Redis cache and reduced p99 latency by 30%.',
  jd_terms: ['Redis'],
  language: 'en',
});

const THIN_SIGNALS = analyzeAnswerSignals({
  answer: 'I am not really sure about that one to be honest.',
  language: 'en',
});

function build(
  llmImpl: jest.Mock = jest.fn().mockResolvedValue({
    rawResponse: { text: '{}' },
    text: '{}',
    parsedJson: {
      talking_point: 'project',
      relevance: 90,
      clarity: 'clear',
      off_topic: false,
      confidence_tone: 'calibrated',
      note: 'Clear, evidence-backed answer.',
    },
    tokenUsage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    estimatedCostUsd: 0.001,
    modelCode: 'gpt-4o-mini',
    latencyMs: 50,
  }),
) {
  const llm = { complete: llmImpl };
  const prompts = {
    get: jest.fn().mockReturnValue({
      code: 'answer_insight',
      version: 1,
      meta: { system: 'judge system' },
    }),
    render: jest.fn((_code: string, vars: Record<string, unknown>) => JSON.stringify(vars)),
  };
  const tracing = {
    startAiRequest: jest.fn().mockResolvedValue('ai-request-1'),
    saveAiResult: jest.fn().mockResolvedValue('ai-result-1'),
    completeAiRequest: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
  };
  return {
    service: new AnswerInsightService(llm as never, prompts as never, tracing as never),
    llm,
    prompts,
    tracing,
  };
}

describe('AnswerInsightService.judge — happy path', () => {
  it('returns a grounded insight from a valid LLM output', async () => {
    const { service } = build();
    const out = await service.judge({
      answer: 'I built a Redis cache and reduced p99 latency by 30%.',
      question: 'Tell me about a performance win.',
      target_dimension: 'technical_depth',
      language: 'en',
      signals: SIGNALS,
    });
    expect(out.talking_point).toBe('project');
    expect(out.relevance).toBe(90);
    expect(out.clarity).toBe('clear');
    // evidence_quality is DERIVED by code from L1 (concrete example present).
    expect(out.evidence_quality).toBe('strong');
  });

  it('passes schema-enforced temp-0 jsonMode options to the LLM', async () => {
    const { service, llm } = build();
    await service.judge({ answer: 'x', language: 'en', signals: SIGNALS });
    const opts = llm.complete.mock.calls[0][1];
    expect(opts).toMatchObject({
      provider: 'openai',
      jsonMode: true,
      temperature: 0,
      maxOutputTokens: 300,
    });
    expect(opts.responseSchema).toMatchObject({ type: 'object', additionalProperties: false });
  });

  it('masks PII in answer + question BEFORE render', async () => {
    const { service, prompts } = build();
    await service.judge({
      answer: 'Email me at candidate@example.com or call 0987 654 321.',
      question: 'Where can I reach you, candidate@example.com?',
      language: 'en',
      signals: SIGNALS,
    });
    const rendered = JSON.stringify(prompts.render.mock.calls[0][1]);
    expect(rendered).not.toContain('candidate@example.com');
    expect(rendered).not.toContain('0987');
    expect(rendered).toContain('[redacted-email]');
    expect(rendered).toContain('[redacted-phone]');
  });

  it('masks PII before any trace write', async () => {
    const { service, tracing } = build();
    await service.judge({
      answer: 'Reach me at candidate@example.com.',
      language: 'en',
      signals: SIGNALS,
    });
    const allTraceWrites = JSON.stringify([
      ...tracing.startAiRequest.mock.calls,
      ...tracing.saveAiResult.mock.calls,
    ]);
    expect(allTraceWrites).not.toContain('candidate@example.com');
  });
});

describe('AnswerInsightService.judge — degrade never throws', () => {
  it('returns a safe fallback when the LLM throws', async () => {
    const { service } = build(jest.fn().mockRejectedValue(new Error('llm down')));
    const out = await service.judge({ answer: 'x', language: 'en', signals: SIGNALS });
    // safe fallback: defaults + evidence_quality still derived from L1 (concrete → strong).
    expect(out.talking_point).toBe('experience');
    expect(out.relevance).toBe(50);
    expect(out.clarity).toBe('adequate');
    expect(out.evidence_quality).toBe('strong');
    expect(out.note).toBe('');
  });

  it('returns a safe fallback when parsedJson is null (bad JSON)', async () => {
    const { service } = build(
      jest.fn().mockResolvedValue({
        rawResponse: { text: 'not json' },
        text: 'not json',
        parsedJson: null,
        tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        modelCode: 'gpt-4o-mini',
        latencyMs: 10,
      }),
    );
    const out = await service.judge({ answer: 'x', language: 'en', signals: THIN_SIGNALS });
    expect(out.talking_point).toBe('experience');
    expect(out.evidence_quality).toBe('thin');
  });

  it('never throws even when tracing itself rejects', async () => {
    const { service, tracing } = build();
    tracing.startAiRequest.mockRejectedValue(new Error('db down'));
    tracing.saveAiResult.mockRejectedValue(new Error('db down'));
    tracing.completeAiRequest.mockRejectedValue(new Error('db down'));
    await expect(
      service.judge({ answer: 'x', language: 'en', signals: SIGNALS }),
    ).resolves.toBeDefined();
  });
});

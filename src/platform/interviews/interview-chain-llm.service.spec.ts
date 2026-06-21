import { InterviewChainLlmService } from './interview-chain-llm.service';

const llmResult = (parsedJson: unknown) => ({
  rawResponse: { text: JSON.stringify(parsedJson) },
  text: JSON.stringify(parsedJson),
  parsedJson,
  tokenUsage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
  estimatedCostUsd: 0.001,
  modelCode: 'gpt-4o-mini',
  provider: 'openai',
  latencyMs: 50,
});

function build(parsedJson: unknown) {
  const llm = { complete: jest.fn().mockResolvedValue(llmResult(parsedJson)) };
  const prompts = {
    get: jest.fn((code: string) => ({
      code: code.replace(/_v\d+$/, ''),
      version: 1,
      meta: { system: `${code} system` },
    })),
    render: jest.fn((_code: string, vars: Record<string, unknown>) => JSON.stringify(vars)),
  };
  const tracing = {
    startAiRequest: jest.fn().mockResolvedValue('ai-request-1'),
    saveAiResult: jest.fn().mockResolvedValue('ai-result-1'),
    completeAiRequest: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
  };

  return {
    service: new InterviewChainLlmService(llm as never, prompts as never, tracing as never),
    llm,
    prompts,
    tracing,
  };
}

describe('InterviewChainLlmService.assess', () => {
  const parsed = {
    score: 72,
    recognized_concepts: ['React Query', 'invented@example.com'],
    depth_signal: 'adequate',
    claim_status: 'partial',
    current_thread: 'React Query cache invalidation',
    gaps_revealed: ['Missing trade-off detail'],
    note: 'Candidate mentioned candidate@example.com.',
  };

  it('calls interview_assess_v1 with schema-enforced temp-0 JSON, seed, and cheap default model', async () => {
    const { service, llm } = build(parsed);

    await service.assess('user-1', {
      sessionId: 'session-1',
      turnOrder: 2,
      language: 'en',
      seniorityTarget: 'mid',
      currentTopic: { id: 'topic-react', display_name: 'React Query' },
      targetDimension: 'technical_depth',
      currentThread: 'React Query',
      drillDepth: 1,
      recentQa: [
        {
          order: 2,
          question: 'Where can I email you?',
          answer: 'Use candidate@example.com or 0987 654 321.',
        },
      ],
    });

    expect(llm.complete).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        provider: 'openai',
        jsonMode: true,
        responseSchema: expect.objectContaining({ type: 'object', additionalProperties: false }),
        temperature: 0,
        seed: expect.any(Number),
        model: 'gpt-4o-mini',
      }),
    );
  });

  it('masks PII before prompt render and trace persistence', async () => {
    const { service, prompts, tracing } = build(parsed);

    await service.assess('user-1', {
      sessionId: 'session-1',
      turnOrder: 2,
      language: 'en',
      seniorityTarget: 'mid',
      currentTopic: { id: 'topic-react', display_name: 'React Query' },
      targetDimension: 'technical_depth',
      currentThread: 'React Query',
      drillDepth: 1,
      recentQa: [
        {
          order: 2,
          question: 'Where can I email you?',
          answer: 'Use candidate@example.com or 0987 654 321.',
        },
      ],
    });

    const renderedVars = JSON.stringify(prompts.render.mock.calls[0][1]);
    expect(renderedVars).not.toContain('candidate@example.com');
    expect(renderedVars).not.toContain('0987');
    expect(renderedVars).toContain('[redacted-email]');
    expect(renderedVars).toContain('[redacted-phone]');

    const traceWrites = JSON.stringify([
      ...tracing.startAiRequest.mock.calls,
      ...tracing.saveAiResult.mock.calls,
    ]);
    expect(traceWrites).not.toContain('candidate@example.com');
    expect(traceWrites).not.toContain('0987');
  });
});

describe('InterviewChainLlmService.ask', () => {
  it('calls interview_ask_v1 with schema-enforced JSON and returns one next question', async () => {
    const { service, llm, tracing } = build({
      ai_message: 'Thanks, let us go one level deeper.',
      question: 'What invalidation trade-off did you choose?',
    });

    const out = await service.ask('user-1', {
      sessionId: 'session-1',
      turnOrder: 3,
      decision: 'drill',
      language: 'en',
      seniorityTarget: 'mid',
      currentTopic: { id: 'topic-react', display_name: 'React Query' },
      currentThread: 'React Query cache invalidation',
      recentQa: [],
      runningNotes: ['Mentioned stale cache issue.'],
      prevTopicOutcome: 'adequate answer',
    });

    expect(llm.complete).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        provider: 'openai',
        jsonMode: true,
        responseSchema: expect.objectContaining({ type: 'object', additionalProperties: false }),
        model: 'gpt-4o-mini',
      }),
    );
    expect(tracing.startAiRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        requestType: 'interview_ask',
        modelCode: 'gpt-4o-mini',
      }),
    );
    expect(out).toMatchObject({
      aiMessage: 'Thanks, let us go one level deeper.',
      question: 'What invalidation trade-off did you choose?',
    });
  });
});

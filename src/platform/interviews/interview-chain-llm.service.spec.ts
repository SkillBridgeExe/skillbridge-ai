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

  it('passes deterministic communication facts into the prompt as code-owned ground truth', async () => {
    const { service, prompts } = build(parsed);

    await service.assess('user-1', {
      sessionId: 'session-1',
      turnOrder: 2,
      language: 'en',
      seniorityTarget: 'mid',
      currentTopic: { id: 'topic-react', display_name: 'React Query' },
      targetDimension: 'communication',
      currentThread: 'React Query',
      drillDepth: 1,
      recentQa: [{ order: 2, question: 'Q', answer: 'A' }],
      communicationFacts: {
        word_count: 42,
        sentence_count: 3,
        filler_count: 5,
        filler_terms: ['basically'],
        hedging_count: 1,
        repeated_terms: ['caching'],
        jd_term_hits: ['React'],
        jd_term_misses: ['GraphQL'],
        star: { situation: true, task: false, action: true, result: false },
        answer_length_band: 'ideal',
        unavailable_reason: 'no_timing_data',
      },
    });

    const vars = prompts.render.mock.calls[0][1] as Record<string, unknown>;
    const facts = JSON.parse(vars.communication_facts as string) as Record<string, unknown>;
    expect(facts.word_count).toBe(42);
    expect(facts.filler_count).toBe(5);
    expect(facts.jd_term_misses).toEqual(['GraphQL']);
  });

  it('renders communication_facts as null when no facts are provided (legacy callers)', async () => {
    const { service, prompts } = build(parsed);

    await service.assess('user-1', {
      sessionId: 'session-1',
      turnOrder: 2,
      language: 'en',
      seniorityTarget: 'mid',
      currentTopic: { id: 'topic-react', display_name: 'React Query' },
      targetDimension: 'technical_depth',
      currentThread: 'React Query',
      drillDepth: 1,
      recentQa: [{ order: 2, question: 'Q', answer: 'A' }],
    });

    const vars = prompts.render.mock.calls[0][1] as Record<string, unknown>;
    expect(vars.communication_facts).toBe('null');
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

  it('passes the drill-ladder focus into the prompt for the given rung', async () => {
    const { service, prompts } = build({
      ai_message: '',
      question: 'Why not a write-through cache?',
    });

    await service.ask('user-1', {
      sessionId: 'session-1',
      turnOrder: 3,
      decision: 'drill',
      language: 'en',
      seniorityTarget: 'senior',
      currentTopic: { id: 'topic-react', display_name: 'React Query' },
      currentThread: 'React Query cache invalidation',
      recentQa: [],
      runningNotes: [],
      prevTopicOutcome: '',
      ladderRung: 'tradeoff',
    });

    const vars = prompts.render.mock.calls[0][1] as Record<string, unknown>;
    expect(String(vars.drill_focus)).toContain('WHY');
    expect(String(vars.scenario_instruction)).toBe('');
  });

  it('passes the I-OWN rungs (reflection / decision_ownership) into the prompt focus', async () => {
    const { service, prompts } = build({ ai_message: '', question: 'Which part was your call?' });

    const askWithRung = async (
      ladderRung: 'reflection' | 'decision_ownership',
    ): Promise<Record<string, unknown>> => {
      prompts.render.mock.calls.length = 0;
      await service.ask('user-1', {
        sessionId: 'session-1',
        turnOrder: 3,
        decision: 'drill',
        language: 'en',
        seniorityTarget: 'fresher',
        currentTopic: { id: 'topic-sync', display_name: 'Inventory sync' },
        currentThread: 'inventory sync',
        recentQa: [],
        runningNotes: [],
        prevTopicOutcome: '',
        ladderRung,
      });
      return prompts.render.mock.calls[0][1] as Record<string, unknown>;
    };

    expect(String((await askWithRung('reflection')).drill_focus)).toContain('HINDSIGHT');
    expect(String((await askWithRung('decision_ownership')).drill_focus)).toContain(
      'THEIR OWN CALL',
    );
  });

  it('activates the metric demand only when the answer was not measured', async () => {
    const { service, prompts } = build({ ai_message: '', question: 'What did that move?' });

    const base = {
      sessionId: 'session-1',
      turnOrder: 4,
      decision: 'drill' as const,
      language: 'en' as const,
      seniorityTarget: 'mid',
      currentTopic: { id: 'topic-sync', display_name: 'Inventory sync' },
      currentThread: 'inventory sync',
      recentQa: [],
      runningNotes: [],
      prevTopicOutcome: '',
      ladderRung: 'application' as const,
    };

    await service.ask('user-1', { ...base, demandMetric: true });
    const withDemand = prompts.render.mock.calls[0][1] as Record<string, unknown>;
    expect(String(withDemand.metric_demand_instruction)).toContain('NO measurable outcome');

    prompts.render.mock.calls.length = 0;
    await service.ask('user-1', base);
    const without = prompts.render.mock.calls[0][1] as Record<string, unknown>;
    expect(String(without.metric_demand_instruction)).toBe('');
  });

  it('activates the incident-simulation instruction only for SCENARIO topics', async () => {
    const { service, prompts } = build({ ai_message: '', question: 'What do you check next?' });

    await service.ask('user-1', {
      sessionId: 'session-1',
      turnOrder: 5,
      decision: 'drill',
      language: 'en',
      seniorityTarget: 'mid',
      currentTopic: { id: 'scenario-1', display_name: 'Scenario: React' },
      currentThread: 'incident handling on React',
      recentQa: [],
      runningNotes: [],
      prevTopicOutcome: '',
      topicPhase: 'SCENARIO',
    });

    const vars = prompts.render.mock.calls[0][1] as Record<string, unknown>;
    expect(String(vars.scenario_instruction)).toContain('INCIDENT SIMULATION');
    expect(String(vars.scenario_instruction)).toContain('ONE short new fact');
  });

  it('renders empty ladder/scenario vars for legacy callers', async () => {
    const { service, prompts } = build({ ai_message: '', question: 'Next question?' });

    await service.ask('user-1', {
      sessionId: 'session-1',
      turnOrder: 3,
      decision: 'advance',
      language: 'en',
      seniorityTarget: 'mid',
      currentTopic: { id: 'topic-x', display_name: 'X' },
      currentThread: 'x',
      recentQa: [],
      runningNotes: [],
      prevTopicOutcome: '',
    });

    const vars = prompts.render.mock.calls[0][1] as Record<string, unknown>;
    expect(vars.drill_focus).toBe('');
    expect(vars.scenario_instruction).toBe('');
  });

  it('drops question-like ai messages in Vietnamese mode while keeping a Vietnamese technical question', async () => {
    const { service } = build({
      ai_message:
        'Let us dive deeper into hooks. Can you explain how you would manage state with useState?',
      question:
        'Khi dùng useState trong một React component, bạn sẽ quản lý state như thế nào khi component mở rộng?',
    });

    const out = await service.ask('user-1', {
      sessionId: 'session-1',
      turnOrder: 4,
      decision: 'drill',
      language: 'vi',
      seniorityTarget: 'junior',
      currentTopic: { id: 'topic-hooks', display_name: 'Hooks' },
      currentThread: 'React hooks and state management',
      recentQa: [],
      runningNotes: ['Ứng viên có nhắc useState và useEffect.'],
      prevTopicOutcome: 'adequate answer',
    });

    expect(out).toMatchObject({
      aiMessage: '',
      question:
        'Khi dùng useState trong một React component, bạn sẽ quản lý state như thế nào khi component mở rộng?',
    });
  });

  it('clears mostly English questions in Vietnamese mode so the caller can use its seed fallback', async () => {
    const { service } = build({
      ai_message: 'Mình chuyển sang phần database design.',
      question: 'Can you describe a specific project where you had to design a database schema?',
    });

    const out = await service.ask('user-1', {
      sessionId: 'session-1',
      turnOrder: 5,
      decision: 'advance',
      language: 'vi',
      seniorityTarget: 'junior',
      currentTopic: { id: 'topic-db', display_name: 'Database Design' },
      currentThread: 'Database Design',
      recentQa: [],
      runningNotes: ['Ứng viên vừa nói về REST API.'],
      prevTopicOutcome: 'adequate answer',
    });

    expect(out).toMatchObject({
      aiMessage: 'Mình chuyển sang phần database design.',
      question: '',
    });
  });

  it('drops mostly English bridge text in Vietnamese mode even when it is not phrased as a question', async () => {
    const { service } = build({
      ai_message:
        'Great insights on your REST API experience. Let us shift gears to database design.',
      question:
        'Cho vai trò Backend Developer, hãy mô tả một ví dụ thực tế liên quan đến database design.',
    });

    const out = await service.ask('user-1', {
      sessionId: 'session-1',
      turnOrder: 5,
      decision: 'advance',
      language: 'vi',
      seniorityTarget: 'junior',
      currentTopic: { id: 'topic-db', display_name: 'Database Design' },
      currentThread: 'Database Design',
      recentQa: [],
      runningNotes: ['Ứng viên vừa nói về REST API.'],
      prevTopicOutcome: 'adequate answer',
    });

    expect(out).toMatchObject({
      aiMessage: '',
      question:
        'Cho vai trò Backend Developer, hãy mô tả một ví dụ thực tế liên quan đến database design.',
    });
  });

  it('passes a natural language instruction into the ask prompt', async () => {
    const { service, prompts } = build({
      ai_message: 'Mình đào sâu thêm một chút.',
      question: 'Bạn xử lý lỗi API như thế nào?',
    });

    await service.ask('user-1', {
      sessionId: 'session-1',
      turnOrder: 3,
      decision: 'drill',
      language: 'vi',
      seniorityTarget: 'junior',
      currentTopic: { id: 'topic-api', display_name: 'API' },
      currentThread: 'API error handling',
      recentQa: [],
      runningNotes: [],
      prevTopicOutcome: 'adequate answer',
    });

    expect(prompts.render).toHaveBeenCalledWith(
      'interview_ask_v1',
      expect.objectContaining({
        language_instruction: expect.stringContaining('Vietnamese'),
      }),
    );
  });
});

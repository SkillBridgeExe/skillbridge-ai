import { runChatToolLoop } from './chat-tool-loop';

function makeLlm(complete: jest.Mock) {
  return { complete } as never;
}

describe('runChatToolLoop', () => {
  it('returns empty/not-degraded immediately when no declarations for the flow', async () => {
    const llm = makeLlm(jest.fn());
    const registry = { invoke: jest.fn() } as never;
    const out = await runChatToolLoop('curation_job', llm, registry, [], [], {});
    expect(out).toEqual({ toolFacts: {}, degraded: false });
  });

  it('no tool call in the decision response → empty, not degraded (normal single-call flow proceeds)', async () => {
    const llm = makeLlm(jest.fn().mockResolvedValue({ text: 'ok', toolCalls: undefined }));
    const registry = { invoke: jest.fn() } as never;
    const out = await runChatToolLoop(
      'diagnosis_chat',
      llm,
      registry,
      [{ name: 'github.enrich', description: 'd', parameters: {} }],
      [],
      {},
    );
    expect(out).toEqual({ toolFacts: {}, degraded: false });
    expect((registry as { invoke: jest.Mock }).invoke).not.toHaveBeenCalled();
  });

  it('one tool call → invokes registry, wraps result as sanitized toolFacts keyed by tool name', async () => {
    const llm = makeLlm(
      jest.fn().mockResolvedValue({
        text: '',
        toolCalls: [{ name: 'github.enrich', args: { username: 'octocat' } }],
      }),
    );
    const invoke = jest.fn().mockResolvedValue({ exists: true, stars: 5 });
    const registry = { invoke } as never;
    const ctx = { userId: 'u1', aiRequestId: 'req-1' };
    const out = await runChatToolLoop(
      'diagnosis_chat',
      llm,
      registry,
      [{ name: 'github.enrich', description: 'd', parameters: {} }],
      [],
      ctx,
    );
    expect(invoke).toHaveBeenCalledWith(
      'diagnosis_chat',
      'github.enrich',
      { username: 'octocat' },
      ctx,
    );
    expect(out.toolFacts['github.enrich']).toEqual({ untrusted_data: { exists: true, stars: 5 } });
    expect(out.degraded).toBe(false);
  });

  it('uses a dedicated tool-decision prompt instead of reusing the final JSON prompt', async () => {
    const complete = jest.fn().mockResolvedValue({ text: '', toolCalls: [] });
    const llm = makeLlm(complete);
    const registry = { invoke: jest.fn() } as never;

    await runChatToolLoop(
      'diagnosis_chat',
      llm,
      registry,
      [{ name: 'github.enrich', description: 'd', parameters: {} }],
      [
        {
          role: 'system',
          content: 'You are the final answerer. Return valid JSON only, no markdown.',
        },
        {
          role: 'user',
          content: 'FULL FACTS + history + final answer schema payload that should not be replayed',
        },
      ],
      {},
    );

    const decisionMessages = complete.mock.calls[0][0];
    expect(decisionMessages).toHaveLength(2);
    expect(decisionMessages[0].role).toBe('system');
    expect(decisionMessages[0].content).toContain('tool-decision');
    expect(decisionMessages[0].content).not.toContain('Return valid JSON only');
    expect(decisionMessages[1].content).not.toContain('FULL FACTS');
  });

  it('hop budget ≤2 — a 3rd requested tool call is dropped and degraded is true', async () => {
    const llm = makeLlm(
      jest.fn().mockResolvedValue({
        text: '',
        toolCalls: [
          { name: 'github.enrich', args: { username: 'a' } },
          { name: 'github.enrich', args: { username: 'b' } },
          { name: 'github.enrich', args: { username: 'c' } },
        ],
      }),
    );
    const invoke = jest.fn().mockResolvedValue({ exists: true });
    const registry = { invoke } as never;
    const out = await runChatToolLoop(
      'diagnosis_chat',
      llm,
      registry,
      [{ name: 'github.enrich', description: 'd', parameters: {} }],
      [],
      {},
    );
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(out.degraded).toBe(true);
  });

  it('a failed/timed-out tool invocation degrades honestly instead of throwing', async () => {
    const llm = makeLlm(
      jest.fn().mockResolvedValue({
        text: '',
        toolCalls: [{ name: 'resource.validate', args: { url: 'https://x.dev' } }],
      }),
    );
    const invoke = jest.fn().mockRejectedValue(new Error('timeout'));
    const registry = { invoke } as never;
    const out = await runChatToolLoop(
      'learning_chat',
      llm,
      registry,
      [{ name: 'resource.validate', description: 'd', parameters: {} }],
      [],
      {},
    );
    expect(out).toEqual({ toolFacts: {}, degraded: true });
  });

  it('the decision LLM call itself throwing degrades to no-tool, never throws out of the loop', async () => {
    const llm = makeLlm(jest.fn().mockRejectedValue(new Error('LLM down')));
    const registry = { invoke: jest.fn() } as never;
    const out = await runChatToolLoop(
      'diagnosis_chat',
      llm,
      registry,
      [{ name: 'github.enrich', description: 'd', parameters: {} }],
      [],
      {},
    );
    expect(out).toEqual({ toolFacts: {}, degraded: false });
  });
});

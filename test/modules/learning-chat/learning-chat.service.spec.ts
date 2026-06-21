import { ChatService } from '../../../src/modules/learning-chat/learning-chat.service';
import { RetrievedResource } from '../../../src/modules/roadmap/resource-embedding';

const res = (id: string): RetrievedResource => ({
  resource_id: id,
  rank: 1,
  title: `T-${id}`,
  provider: 'P',
  source_type: 'course',
  outcome_type: 'practice',
});

function makeService(over: {
  retrieved?: RetrievedResource[];
  llmResult?: { parsedJson?: unknown; text: string };
}) {
  const retriever = { nearest: jest.fn(async () => over.retrieved ?? [res('r1')]) };
  const llm = {
    complete: jest.fn(
      async () =>
        over.llmResult ?? {
          parsedJson: {
            message: 'Học r1 nhé',
            cited_resource_ids: ['r1'],
            suggested_next_step: 'deploy a container',
          },
          text: '',
        },
    ),
  };
  const prompts = {
    render: jest.fn(() => 'RENDERED'),
    get: jest.fn(() => ({ meta: { system: 'SYS' } })),
  };
  const svc = new ChatService(retriever as never, llm as never, prompts as never);
  return { svc, retriever, llm, prompts };
}

describe('ChatService.turn', () => {
  it('retrieves, calls the schema-enforced LLM, grounds, and returns the answer', async () => {
    const { svc, retriever, llm } = makeService({});
    const out = await svc.turn({ question: 'tôi thiếu Docker thì học gì?', language: 'vi' });

    expect(retriever.nearest).toHaveBeenCalledTimes(1);
    const llmOpts = (llm.complete.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(llmOpts.jsonMode).toBe(true);
    expect(llmOpts.responseSchema).toBeDefined();
    expect(llmOpts.temperature).toBeGreaterThan(0);
    expect(out.cited_resources.map((r) => r.resource_id)).toEqual(['r1']);
    expect(out.suggested_next_step).toBe('deploy a container');
    expect(out.retrieved.map((r) => r.resource_id)).toEqual(['r1']);
  });

  it('drops a fabricated citation the LLM returned (grounding)', async () => {
    const { svc } = makeService({
      retrieved: [res('r1')],
      llmResult: { parsedJson: { message: 'x', cited_resource_ids: ['r1', 'GHOST'] }, text: '' },
    });
    const out = await svc.turn({ question: 'q' });
    expect(out.cited_resources.map((r) => r.resource_id)).toEqual(['r1']);
  });

  it('strips a raw URL the LLM put in the message', async () => {
    const { svc } = makeService({
      retrieved: [res('r1')],
      llmResult: {
        parsedJson: { message: 'Vào https://fake.example đi', cited_resource_ids: ['r1'] },
        text: '',
      },
    });
    const out = await svc.turn({ question: 'q' });
    expect(out.message).not.toMatch(/https?:\/\//i);
  });

  it('masks PII in the question before retrieval and the prompt (F3)', async () => {
    const { svc, retriever } = makeService({});
    await svc.turn({ question: 'email me at john@doe.com about Docker' });
    const query = (retriever.nearest.mock.calls[0] as unknown[])[0] as { query: string };
    expect(query.query).not.toContain('john@doe.com');
    expect(query.query).toContain('[redacted-email]');
  });

  it('empty retrieved set → honest answer, no citations', async () => {
    const { svc } = makeService({
      retrieved: [],
      llmResult: {
        parsedJson: { message: 'Mình chưa có tài nguyên phù hợp.', cited_resource_ids: [] },
        text: '',
      },
    });
    const out = await svc.turn({ question: 'học COBOL?' });
    expect(out.cited_resources).toEqual([]);
    expect(out.retrieved).toEqual([]);
    expect(out.message.length).toBeGreaterThan(0);
  });

  it('falls back deterministically when the LLM returns non-JSON garbage', async () => {
    const { svc } = makeService({
      retrieved: [res('r1')],
      llmResult: { parsedJson: undefined, text: 'not json at all' },
    });
    const out = await svc.turn({ question: 'q' });
    expect(out.cited_resources.map((r) => r.resource_id)).toEqual(['r1']);
    expect(out.message.length).toBeGreaterThan(0);
  });

  it('degrades to the deterministic grounded fallback when llm.complete THROWS (resilience)', async () => {
    const retriever = { nearest: jest.fn(async () => [res('r1')]) };
    const llm = {
      complete: jest.fn(async () => {
        throw new Error('provider 503');
      }),
    };
    const prompts = { render: jest.fn(() => 'R'), get: jest.fn(() => ({ meta: { system: 'S' } })) };
    const svc = new ChatService(retriever as never, llm as never, prompts as never);
    const out = await svc.turn({ question: 'tôi thiếu Docker thì học gì?' });
    expect(out.cited_resources.map((r) => r.resource_id)).toEqual(['r1']); // fallback over retrieved
    expect(out.message.length).toBeGreaterThan(0);
    expect(out.retrieved.map((r) => r.resource_id)).toEqual(['r1']);
  });

  it('masks PII in BOTH the question and the conversation history before the prompt (F3)', async () => {
    const { svc, prompts } = makeService({});
    await svc.turn({
      question: 'email me at john@doe.com',
      history: [{ role: 'user', content: 'my phone is 0901234567' }],
    });
    const vars = JSON.stringify((prompts.render.mock.calls[0] as unknown[])[1]);
    expect(vars).not.toContain('john@doe.com');
    expect(vars).not.toContain('0901234567');
    expect(vars).toContain('[redacted-email]');
    expect(vars).toContain('[redacted-phone]');
  });
});

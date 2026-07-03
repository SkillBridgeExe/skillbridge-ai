import { TracingService } from './tracing.service';

function makeService(overrides: { aiRequests?: any; aiToolCalls?: any } = {}) {
  const aiRequests = overrides.aiRequests;
  const aiToolCalls = overrides.aiToolCalls ?? {
    save: jest.fn().mockImplementation((row) => Promise.resolve({ id: 'tool-call-1', ...row })),
    count: jest.fn().mockResolvedValue(0),
    create: jest.fn().mockImplementation((row) => row),
  };
  // positional: (aiRequests?, aiResults?, aiToolCalls?) — aiResults always undefined here (stub path).
  const service = new TracingService(aiRequests, undefined, aiToolCalls);
  return { service, aiRequests, aiToolCalls };
}

describe('TracingService.logToolCall (un-stubbed)', () => {
  it('persists a real row with the given args_hash, no raw args', async () => {
    const { service, aiToolCalls } = makeService();
    await service.logToolCall({
      aiRequestId: 'req-1',
      userId: 'user-1',
      toolName: 'github.enrich',
      argsHash: 'a'.repeat(64),
      latencyMs: 120,
      status: 'SUCCESS',
    });
    expect(aiToolCalls.create).toHaveBeenCalledWith(
      expect.objectContaining({
        aiRequestId: 'req-1',
        userId: 'user-1',
        toolName: 'github.enrich',
        argsHash: 'a'.repeat(64),
        status: 'SUCCESS',
      }),
    );
    expect(aiToolCalls.save).toHaveBeenCalled();
  });

  it('falls back to the debug-log stub when no repo is injected (test/NODE_ENV path)', async () => {
    const service = new TracingService();
    const id = await service.logToolCall({
      toolName: 'resource.validate',
      argsHash: 'b'.repeat(64),
      status: 'FAILED',
    });
    expect(typeof id).toBe('string');
  });
});

describe('TracingService.countToolCallsSince', () => {
  it('counts rows for the user+tool since the given date', async () => {
    const aiToolCalls = { count: jest.fn().mockResolvedValue(3) };
    const { service } = makeService({ aiToolCalls });
    const since = new Date('2026-07-02T00:00:00Z');
    const n = await service.countToolCallsSince('user-1', 'github.enrich', since);
    expect(n).toBe(3);
    expect(aiToolCalls.count).toHaveBeenCalledWith({
      where: { userId: 'user-1', toolName: 'github.enrich', createdAt: expect.anything() },
    });
  });

  it('returns 0 when no repo injected (stub path)', async () => {
    const service = new TracingService();
    const n = await service.countToolCallsSince('user-1', 'x', new Date());
    expect(n).toBe(0);
  });
});

describe('TracingService.completeAiRequest — REJECTED status (T5)', () => {
  it('persists status REJECTED on ai_requests (deterministic-reject completion, not SUCCESS/FAILED)', async () => {
    const aiRequests = {
      update: jest.fn().mockResolvedValue(undefined),
      manager: { query: jest.fn() },
    };
    const { service } = makeService({ aiRequests });
    await service.completeAiRequest('req-1', {
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      estimatedCost: 0.001,
      latencyMs: 42,
      status: 'REJECTED',
    });
    expect(aiRequests.update).toHaveBeenCalledWith(
      'req-1',
      expect.objectContaining({ status: 'REJECTED', estimatedCost: '0.001000' }),
    );
  });
});

describe('TracingService.countRejectedSince (T5 — abuse throttle)', () => {
  it('counts REJECTED ai_requests rows for the user since the given date', async () => {
    const aiRequests = { count: jest.fn().mockResolvedValue(5) };
    const { service } = makeService({ aiRequests });
    const since = new Date('2026-07-03T00:00:00Z');
    const n = await service.countRejectedSince('user-1', since);
    expect(n).toBe(5);
    expect(aiRequests.count).toHaveBeenCalledWith({
      where: { userId: 'user-1', status: 'REJECTED', createdAt: expect.anything() },
    });
  });

  it('returns 0 when no repo injected (stub path — throttle never blocks where tracing is disabled)', async () => {
    const service = new TracingService();
    const n = await service.countRejectedSince('user-1', new Date());
    expect(n).toBe(0);
  });
});

import { TracingService } from './tracing.service';

function makeService(overrides: { aiToolCalls?: any } = {}) {
  const aiToolCalls = overrides.aiToolCalls ?? {
    save: jest.fn().mockImplementation((row) => Promise.resolve({ id: 'tool-call-1', ...row })),
    count: jest.fn().mockResolvedValue(0),
    create: jest.fn().mockImplementation((row) => row),
  };
  // positional: (aiRequests?, aiResults?, aiToolCalls?) — aiRequests/aiResults undefined → stub path for those.
  const service = new TracingService(undefined, undefined, aiToolCalls);
  return { service, aiToolCalls };
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

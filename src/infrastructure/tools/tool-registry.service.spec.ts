import { ToolRegistry } from './tool-registry.service';
import {
  ToolAdapter,
  ToolBadArgsError,
  ToolCircuitOpenError,
  ToolNotAllowedError,
  ToolRateLimitError,
  ToolTimeoutError,
} from './types';

type TestToolAdapter = ToolAdapter<unknown, unknown>;
type TestTracing = {
  logToolCall: jest.Mock<Promise<string>, [unknown]>;
  countToolCallsSince: jest.Mock<Promise<number>, [string, string, Date]>;
};

function makeRegistry(
  overrides: {
    resourceValidate?: TestToolAdapter;
    githubEnrich?: TestToolAdapter;
    tracing?: TestTracing;
  } = {},
) {
  const resourceValidate: TestToolAdapter = overrides.resourceValidate ?? {
    name: 'resource.validate',
    argsSchema: jest.fn((a) => a),
    invoke: jest.fn().mockResolvedValue({ alive: true }),
  };
  const githubEnrich: TestToolAdapter = overrides.githubEnrich ?? {
    name: 'github.enrich',
    argsSchema: jest.fn((a) => a),
    invoke: jest.fn().mockResolvedValue({ exists: true }),
  };
  const tracing: TestTracing = overrides.tracing ?? {
    logToolCall: jest.fn().mockResolvedValue('log-1'),
    countToolCallsSince: jest.fn().mockResolvedValue(0),
  };
  const registry = new ToolRegistry(
    tracing as never,
    resourceValidate as never,
    githubEnrich as never,
  );
  return { registry, resourceValidate, githubEnrich, tracing };
}

describe('ToolRegistry.invoke', () => {
  it('rejects a tool not allow-listed for the flow', async () => {
    const { registry, githubEnrich } = makeRegistry();
    await expect(registry.invoke('learning_chat', 'github.enrich', {}, {})).rejects.toBeInstanceOf(
      ToolNotAllowedError,
    );
    expect(githubEnrich.invoke).not.toHaveBeenCalled();
  });

  it('rejects an unregistered tool name', async () => {
    const { registry } = makeRegistry();
    await expect(registry.invoke('diagnosis_chat', 'not.a.tool', {}, {})).rejects.toBeInstanceOf(
      ToolNotAllowedError,
    );
  });

  it('succeeds and logs SUCCESS with a deterministic args_hash', async () => {
    const { registry, githubEnrich, tracing } = makeRegistry();
    const result = await registry.invoke(
      'diagnosis_chat',
      'github.enrich',
      { username: 'octocat' },
      { aiRequestId: 'req-1' },
    );
    expect(result).toEqual({ exists: true });
    expect(githubEnrich.invoke).toHaveBeenCalledWith(
      { username: 'octocat' },
      expect.objectContaining({ aiRequestId: 'req-1', signal: expect.any(AbortSignal) }),
    );
    expect(tracing.logToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'github.enrich',
        status: 'SUCCESS',
        argsHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
  });

  it('wraps a bad-args throw as ToolBadArgsError and never invokes or logs', async () => {
    const githubEnrich = {
      name: 'github.enrich',
      argsSchema: jest.fn(() => {
        throw new Error('missing username');
      }),
      invoke: jest.fn(),
    };
    const { registry, tracing } = makeRegistry({ githubEnrich });
    await expect(registry.invoke('diagnosis_chat', 'github.enrich', {}, {})).rejects.toBeInstanceOf(
      ToolBadArgsError,
    );
    expect(githubEnrich.invoke).not.toHaveBeenCalled();
    expect(tracing.logToolCall).not.toHaveBeenCalled();
  });

  it('times out a hanging adapter after 10s and logs FAILED', async () => {
    jest.useFakeTimers();
    const githubEnrich = {
      name: 'github.enrich',
      argsSchema: jest.fn((a) => a),
      invoke: jest.fn(() => new Promise(() => {})), // never resolves
    };
    const { registry, tracing } = makeRegistry({ githubEnrich });
    const promise = registry.invoke('diagnosis_chat', 'github.enrich', { username: 'x' }, {});
    const assertion = expect(promise).rejects.toBeInstanceOf(ToolTimeoutError);
    await jest.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(tracing.logToolCall).toHaveBeenCalledWith(expect.objectContaining({ status: 'FAILED' }));
    jest.useRealTimers();
  });

  it('aborts the adapter signal when the timeout fires so background network work can stop', async () => {
    jest.useFakeTimers();
    let receivedSignal: AbortSignal | undefined;
    let aborted = false;
    const githubEnrich = {
      name: 'github.enrich',
      argsSchema: jest.fn((a) => a),
      invoke: jest.fn((_args, ctx) => {
        receivedSignal = ctx.signal;
        ctx.signal?.addEventListener('abort', () => {
          aborted = true;
        });
        return new Promise(() => {});
      }),
    };
    const { registry } = makeRegistry({ githubEnrich });

    const promise = registry.invoke('diagnosis_chat', 'github.enrich', { username: 'x' }, {});
    const assertion = expect(promise).rejects.toBeInstanceOf(ToolTimeoutError);
    await jest.advanceTimersByTimeAsync(10_000);
    await assertion;

    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal?.aborted).toBe(true);
    expect(aborted).toBe(true);
    jest.useRealTimers();
  });

  it('rejects with ToolRateLimitError once the per-user tool window is exhausted', async () => {
    const tracing: TestTracing = {
      logToolCall: jest.fn(),
      countToolCallsSince: jest.fn().mockResolvedValue(20),
    };
    const { registry, githubEnrich } = makeRegistry({ tracing });
    await expect(
      registry.invoke('diagnosis_chat', 'github.enrich', { username: 'x' }, { userId: 'u1' }),
    ).rejects.toBeInstanceOf(ToolRateLimitError);
    expect(tracing.countToolCallsSince).toHaveBeenCalledWith(
      'u1',
      'github.enrich',
      expect.any(Date),
    );
    expect(githubEnrich.invoke).not.toHaveBeenCalled();
  });

  it('keeps rate-limit isolated per user: user A at limit does not imply user B is blocked', async () => {
    const tracing: TestTracing = {
      logToolCall: jest.fn().mockResolvedValue('log-1'),
      countToolCallsSince: jest.fn(async (userId: string, _toolName: string, _since: Date) =>
        userId === 'u1' ? 20 : 0,
      ),
    };
    const { registry, githubEnrich } = makeRegistry({ tracing });

    await expect(
      registry.invoke('diagnosis_chat', 'github.enrich', { username: 'x' }, { userId: 'u1' }),
    ).rejects.toBeInstanceOf(ToolRateLimitError);

    await expect(
      registry.invoke('diagnosis_chat', 'github.enrich', { username: 'x' }, { userId: 'u2' }),
    ).resolves.toEqual({ exists: true });

    expect(githubEnrich.invoke).toHaveBeenCalledTimes(1);
    expect(tracing.logToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u2', status: 'SUCCESS' }),
    );
  });

  it('validates args before checking quota, so malformed args do not hit the rate-limit path', async () => {
    const githubEnrich = {
      name: 'github.enrich',
      argsSchema: jest.fn(() => {
        throw new Error('missing username');
      }),
      invoke: jest.fn(),
    };
    const tracing = {
      logToolCall: jest.fn(),
      countToolCallsSince: jest.fn().mockResolvedValue(20),
    };
    const { registry } = makeRegistry({ githubEnrich, tracing });

    await expect(
      registry.invoke('diagnosis_chat', 'github.enrich', {}, { userId: 'u1' }),
    ).rejects.toBeInstanceOf(ToolBadArgsError);
    expect(tracing.countToolCallsSince).not.toHaveBeenCalled();
  });

  it('opens the circuit after 5 consecutive failures and short-circuits the 6th call', async () => {
    const githubEnrich = {
      name: 'github.enrich',
      argsSchema: jest.fn((a) => a),
      invoke: jest.fn().mockRejectedValue(new Error('boom')),
    };
    const { registry } = makeRegistry({ githubEnrich });
    for (let i = 0; i < 5; i++) {
      await expect(
        registry.invoke('diagnosis_chat', 'github.enrich', { username: 'x' }, {}),
      ).rejects.toThrow('boom');
    }
    await expect(
      registry.invoke('diagnosis_chat', 'github.enrich', { username: 'x' }, {}),
    ).rejects.toBeInstanceOf(ToolCircuitOpenError);
    expect(githubEnrich.invoke).toHaveBeenCalledTimes(5); // 6th call short-circuited, not a 6th real invoke
  });
});

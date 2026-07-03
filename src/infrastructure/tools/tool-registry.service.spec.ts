import { ToolRegistry } from './tool-registry.service';
import {
  ToolBadArgsError,
  ToolCircuitOpenError,
  ToolNotAllowedError,
  ToolRateLimitError,
  ToolTimeoutError,
} from './types';

function makeRegistry(
  overrides: { resourceValidate?: any; githubEnrich?: any; tracing?: any } = {},
) {
  const resourceValidate: any = overrides.resourceValidate ?? {
    name: 'resource.validate',
    argsSchema: jest.fn((a) => a),
    invoke: jest.fn().mockResolvedValue({ alive: true }),
  };
  const githubEnrich: any = overrides.githubEnrich ?? {
    name: 'github.enrich',
    argsSchema: jest.fn((a) => a),
    invoke: jest.fn().mockResolvedValue({ exists: true }),
  };
  const tracing: any = overrides.tracing ?? {
    logToolCall: jest.fn().mockResolvedValue('log-1'),
    countToolCallsSince: jest.fn().mockResolvedValue(0),
  };
  const registry = new ToolRegistry(tracing, resourceValidate, githubEnrich);
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
      { aiRequestId: 'req-1' },
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

  it('rejects with ToolRateLimitError once the per-tool window is exhausted', async () => {
    const tracing = {
      logToolCall: jest.fn(),
      countToolCallsSince: jest.fn().mockResolvedValue(20),
    };
    const { registry, githubEnrich } = makeRegistry({ tracing });
    await expect(
      registry.invoke('diagnosis_chat', 'github.enrich', { username: 'x' }, { userId: 'u1' }),
    ).rejects.toBeInstanceOf(ToolRateLimitError);
    expect(githubEnrich.invoke).not.toHaveBeenCalled();
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

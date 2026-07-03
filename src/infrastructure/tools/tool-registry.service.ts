import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { TracingService } from '../../modules/tracing/tracing.service';
import { TOOL_ALLOW_LIST } from './allow-list';
import {
  ToolAdapter,
  ToolBadArgsError,
  ToolCircuitOpenError,
  ToolContext,
  ToolNotAllowedError,
  ToolRateLimitError,
  ToolTimeoutError,
} from './types';
import { ResourceValidateAdapter } from './adapters/resource-validate.adapter';
import { GithubEnrichAdapter } from './adapters/github-enrich.adapter';

const TIMEOUT_MS = 10_000;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1h
const RATE_LIMIT_MAX = 20; // per user + tool
const CIRCUIT_FAIL_THRESHOLD = 5;
const CIRCUIT_OPEN_MS = 5 * 60 * 1000; // 5 min

interface CircuitState {
  consecutiveFailures: number;
  openUntil: number;
}

/**
 * Allow-listed / timeout-bounded / rate-limited / circuit-broken / audited entry point for every
 * LLM-callable tool (#22 §5). Only 2 tools exist today — adapters are injected concretely rather
 * than via a generic provider-token array (YAGNI: a 3rd tool adds one constructor param).
 */
@Injectable()
export class ToolRegistry {
  private readonly logger = new Logger(ToolRegistry.name);
  private readonly adapters: Map<string, ToolAdapter<unknown, unknown>>;
  private readonly circuits = new Map<string, CircuitState>();

  constructor(
    private readonly tracing: TracingService,
    resourceValidate: ResourceValidateAdapter,
    githubEnrich: GithubEnrichAdapter,
  ) {
    this.adapters = new Map<string, ToolAdapter<unknown, unknown>>([
      [resourceValidate.name, resourceValidate as ToolAdapter<unknown, unknown>],
      [githubEnrich.name, githubEnrich as ToolAdapter<unknown, unknown>],
    ]);
  }

  async invoke(flow: string, name: string, args: unknown, ctx: ToolContext): Promise<unknown> {
    if (!(TOOL_ALLOW_LIST[flow] ?? []).includes(name)) {
      throw new ToolNotAllowedError(`tool "${name}" not allow-listed for flow "${flow}"`);
    }
    const adapter = this.adapters.get(name);
    if (!adapter) throw new ToolNotAllowedError(`tool "${name}" is not registered`);

    const circuit = this.circuits.get(name);
    if (circuit && circuit.openUntil > Date.now()) {
      throw new ToolCircuitOpenError(
        `tool "${name}" circuit open until ${new Date(circuit.openUntil).toISOString()}`,
      );
    }

    let parsedArgs: unknown;
    try {
      parsedArgs = adapter.argsSchema(args);
    } catch (err) {
      throw new ToolBadArgsError((err as Error).message);
    }

    if (ctx.userId) {
      const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);
      const count = await this.tracing.countToolCallsSince(ctx.userId, name, since);
      if (count >= RATE_LIMIT_MAX) {
        throw new ToolRateLimitError(`tool "${name}" rate limit reached (${RATE_LIMIT_MAX}/h)`);
      }
    }

    const argsHash = createHash('sha256').update(JSON.stringify(parsedArgs)).digest('hex');
    const start = Date.now();
    const controller = new AbortController();
    const parentAbort = () => controller.abort(ctx.signal?.reason);
    if (ctx.signal?.aborted) {
      controller.abort(ctx.signal.reason);
    } else {
      ctx.signal?.addEventListener('abort', parentAbort, { once: true });
    }
    const toolCtx: ToolContext = { ...ctx, signal: controller.signal };
    try {
      const result = await this.withTimeout(adapter.invoke(parsedArgs, toolCtx), name, controller);
      this.circuits.delete(name);
      await this.tracing.logToolCall({
        aiRequestId: ctx.aiRequestId,
        userId: ctx.userId,
        toolName: name,
        argsHash,
        latencyMs: Date.now() - start,
        status: 'SUCCESS',
      });
      return result;
    } catch (err) {
      this.recordFailure(name);
      await this.tracing.logToolCall({
        aiRequestId: ctx.aiRequestId,
        userId: ctx.userId,
        toolName: name,
        argsHash,
        latencyMs: Date.now() - start,
        status: 'FAILED',
        errorMessage: (err as Error).message,
      });
      throw err;
    } finally {
      ctx.signal?.removeEventListener('abort', parentAbort);
    }
  }

  private withTimeout<T>(p: Promise<T>, name: string, controller: AbortController): Promise<T> {
    let timer!: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(new ToolTimeoutError(`tool "${name}" timed out after ${TIMEOUT_MS}ms`));
        reject(new ToolTimeoutError(`tool "${name}" timed out after ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }

  private recordFailure(name: string): void {
    const state = this.circuits.get(name) ?? { consecutiveFailures: 0, openUntil: 0 };
    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= CIRCUIT_FAIL_THRESHOLD) {
      state.openUntil = Date.now() + CIRCUIT_OPEN_MS;
      this.logger.warn(
        `tool "${name}" circuit OPEN for ${CIRCUIT_OPEN_MS / 1000}s after ${state.consecutiveFailures} consecutive failures`,
      );
    }
    this.circuits.set(name, state);
  }
}

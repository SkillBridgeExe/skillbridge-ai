export interface ToolContext {
  userId?: string;
  aiRequestId?: string;
}

/** A → parsed/validated args type, R → structured result (FACTS) type. */
export interface ToolAdapter<A, R> {
  readonly name: string;
  argsSchema: (args: unknown) => A;
  invoke(args: A, ctx: ToolContext): Promise<R>;
}

export class ToolNotAllowedError extends Error {}
export class ToolBadArgsError extends Error {}
export class ToolTimeoutError extends Error {}
export class ToolCircuitOpenError extends Error {}
export class ToolRateLimitError extends Error {}

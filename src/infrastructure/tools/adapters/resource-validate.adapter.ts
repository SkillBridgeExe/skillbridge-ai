import { ToolAdapter, ToolContext } from '../types';

/**
 * Stub — implemented in Task 3.
 * Validates resource URLs via HEAD request (alive check).
 */
export class ResourceValidateAdapter implements ToolAdapter<{ url: string }, { alive: boolean }> {
  readonly name = 'resource.validate';

  argsSchema(args: unknown): { url: string } {
    throw new Error('Not implemented in stub');
  }

  async invoke(args: { url: string }, ctx: ToolContext): Promise<{ alive: boolean }> {
    throw new Error('Not implemented in stub');
  }
}

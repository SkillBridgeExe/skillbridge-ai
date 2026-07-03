import { ToolAdapter, ToolContext } from '../types';

/**
 * Stub — implemented in Task 5.
 * Enriches GitHub user profiles with public data (repos, stars, orgs, bio).
 */
export class GithubEnrichAdapter implements ToolAdapter<{ username: string }, { exists: boolean }> {
  readonly name = 'github.enrich';

  argsSchema(args: unknown): { username: string } {
    throw new Error('Not implemented in stub');
  }

  async invoke(args: { username: string }, ctx: ToolContext): Promise<{ exists: boolean }> {
    throw new Error('Not implemented in stub');
  }
}

import { Injectable } from '@nestjs/common';
import { ToolAdapter, ToolBadArgsError, ToolContext } from '../types';
import {
  GithubClientService,
  GithubUserNotFoundError,
} from '../../../modules/github-evidence/github-client.service';

export interface GithubEnrichArgs {
  username: string;
}

export interface GithubEnrichResult {
  exists: boolean;
  public_repos: Array<{
    name: string;
    language: string | null;
    stars: number;
    pushed_at: string | null;
  }>;
  languages_summary: Record<string, number>;
  recent_activity_days: number | null;
}

const USERNAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;

/**
 * Enriches a GitHub username with public repo data for the chat tool loop (#22). Reuses
 * GithubClientService (same 24h cache as the evidence-ledger feature) — never throws on a
 * missing/unknown user, always returns a shaped `exists:false` result instead.
 */
@Injectable()
export class GithubEnrichAdapter implements ToolAdapter<GithubEnrichArgs, GithubEnrichResult> {
  readonly name = 'github.enrich';

  constructor(private readonly client: GithubClientService) {}

  argsSchema(args: unknown): GithubEnrichArgs {
    const username = (args as { username?: unknown })?.username;
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
      throw new ToolBadArgsError('github.enrich requires a valid GitHub username');
    }
    return { username };
  }

  async invoke(args: GithubEnrichArgs, _ctx: ToolContext): Promise<GithubEnrichResult> {
    let repos;
    try {
      repos = await this.client.fetchPublicRepos(args.username);
    } catch (err) {
      if (err instanceof GithubUserNotFoundError) {
        return {
          exists: false,
          public_repos: [],
          languages_summary: {},
          recent_activity_days: null,
        };
      }
      throw err;
    }

    const owned = repos
      .filter((r) => !r.fork)
      .sort((a, b) => (b.pushed_at ?? '').localeCompare(a.pushed_at ?? ''));

    const languages_summary: Record<string, number> = {};
    for (const r of owned) {
      if (r.language) languages_summary[r.language] = (languages_summary[r.language] ?? 0) + 1;
    }

    const mostRecent = owned.find((r) => r.pushed_at)?.pushed_at ?? null;
    const recent_activity_days = mostRecent
      ? Math.floor((Date.now() - new Date(mostRecent).getTime()) / 86_400_000)
      : null;

    return {
      exists: true,
      public_repos: owned.slice(0, 10).map((r) => ({
        name: r.name,
        language: r.language,
        stars: r.stars,
        pushed_at: r.pushed_at,
      })),
      languages_summary,
      recent_activity_days,
    };
  }
}

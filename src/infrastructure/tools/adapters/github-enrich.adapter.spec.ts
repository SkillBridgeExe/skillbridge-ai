import { GithubEnrichAdapter } from './github-enrich.adapter';
import { GithubUserNotFoundError } from '../../../modules/github-evidence/github-client.service';
import { ToolBadArgsError } from '../types';

function makeAdapter(fetchPublicRepos: jest.Mock) {
  return new GithubEnrichAdapter({ fetchPublicRepos } as never);
}

describe('GithubEnrichAdapter', () => {
  it('rejects an invalid username', () => {
    const adapter = makeAdapter(jest.fn());
    expect(() => adapter.argsSchema({})).toThrow(ToolBadArgsError);
    expect(() => adapter.argsSchema({ username: 'bad username!' })).toThrow(ToolBadArgsError);
  });

  it('shapes repos, languages_summary and recent_activity_days from real client data', async () => {
    const now = Date.now();
    const pushedRecently = new Date(now - 2 * 86_400_000).toISOString();
    const fetchPublicRepos = jest.fn().mockResolvedValue([
      {
        name: 'app',
        html_url: 'u',
        fork: false,
        language: 'TypeScript',
        topics: [],
        description: null,
        pushed_at: pushedRecently,
        stars: 5,
      },
      {
        name: 'old',
        html_url: 'u2',
        fork: false,
        language: 'TypeScript',
        topics: [],
        description: null,
        pushed_at: '2020-01-01T00:00:00Z',
        stars: 1,
      },
      {
        name: 'forked',
        html_url: 'u3',
        fork: true,
        language: 'Python',
        topics: [],
        description: null,
        pushed_at: pushedRecently,
        stars: 0,
      },
    ]);
    const adapter = makeAdapter(fetchPublicRepos);
    const result = await adapter.invoke({ username: 'octocat' }, {});
    expect(result.exists).toBe(true);
    expect(result.public_repos.map((r) => r.name)).toEqual(['app', 'old']); // forks excluded
    expect(result.languages_summary).toEqual({ TypeScript: 2 });
    expect(result.recent_activity_days).toBe(2);
  });

  it('returns exists:false (never throws) for a 404 username', async () => {
    const fetchPublicRepos = jest.fn().mockRejectedValue(new GithubUserNotFoundError('nope'));
    const adapter = makeAdapter(fetchPublicRepos);
    const result = await adapter.invoke({ username: 'nope' }, {});
    expect(result).toEqual({
      exists: false,
      public_repos: [],
      languages_summary: {},
      recent_activity_days: null,
    });
  });

  it('caps public_repos at 10', async () => {
    const repos = Array.from({ length: 15 }, (_, i) => ({
      name: `r${i}`,
      html_url: 'u',
      fork: false,
      language: 'TS',
      topics: [],
      description: null,
      pushed_at: null,
      stars: 0,
    }));
    const adapter = makeAdapter(jest.fn().mockResolvedValue(repos));
    const result = await adapter.invoke({ username: 'x' }, {});
    expect(result.public_repos).toHaveLength(10);
  });
});

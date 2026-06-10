import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GithubRepo } from './github-evidence';

export class GithubUserNotFoundError extends Error {}
export class GithubRateLimitError extends Error {}
export class GithubFetchError extends Error {}

const TTL_MS = 6 * 60 * 60 * 1000; // 6h — ToS-friendly caching
const CACHE_MAX = 500;
const TIMEOUT_MS = 8000;

/** Public-repos client. Unauthenticated works (60 req/h); set GITHUB_TOKEN (classic PAT, NO
 *  scopes — public read) for 5000 req/h. Reads ONLY the fields GithubRepo declares. */
@Injectable()
export class GithubClientService {
  private readonly logger = new Logger(GithubClientService.name);
  private readonly cache = new Map<string, { at: number; repos: GithubRepo[] }>();

  constructor(private readonly config: ConfigService) {}

  async fetchPublicRepos(username: string): Promise<GithubRepo[]> {
    const key = username.toLowerCase();
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.repos;

    const headers: Record<string, string> = {
      'User-Agent': 'SkillBridgeBot/1.0 (+https://skillbridge.vn/bot)',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    const token = this.config.get<string>('GITHUB_TOKEN');
    if (token) headers.Authorization = `Bearer ${token}`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(
        `https://api.github.com/users/${encodeURIComponent(username)}/repos?per_page=100&sort=pushed&type=owner`,
        { headers, signal: ctrl.signal },
      );
    } catch (err) {
      throw new GithubFetchError(`github fetch failed: ${String(err)}`);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 404) throw new GithubUserNotFoundError(username);
    if (res.status === 403 || res.status === 429) throw new GithubRateLimitError(String(res.status));
    if (!res.ok) throw new GithubFetchError(`github status ${res.status}`);

    const raw = (await res.json()) as Array<Record<string, unknown>>;
    const repos: GithubRepo[] = (Array.isArray(raw) ? raw : []).map((r) => ({
      name: String(r.name ?? ''),
      html_url: String(r.html_url ?? ''),
      fork: Boolean(r.fork),
      language: typeof r.language === 'string' ? r.language : null,
      topics: Array.isArray(r.topics) ? (r.topics as string[]).filter((t) => typeof t === 'string') : [],
      description: typeof r.description === 'string' ? r.description : null,
      pushed_at: typeof r.pushed_at === 'string' ? r.pushed_at : null,
    }));

    if (this.cache.size >= CACHE_MAX) {
      const first = this.cache.keys().next().value;
      if (first !== undefined) this.cache.delete(first);
    }
    this.cache.set(key, { at: Date.now(), repos });
    return repos;
  }
}

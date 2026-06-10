/**
 * Task 2 tests:
 *  - "GithubClientService" describe: mock global.fetch, real ConfigService mock.
 *  - "GithubEvidenceService" describe: mock client, REAL SkillNormalizerService + SkillTextScannerService.
 */
import { GithubClientService, GithubFetchError, GithubRateLimitError, GithubUserNotFoundError } from '../../../src/modules/github-evidence/github-client.service';
import { GithubEvidenceService } from '../../../src/modules/github-evidence/github-evidence.service';
import { CvReviewParsedResponse } from '../../../src/modules/cv-review/dto/cv-review-response.dto';
import { SkillTaxonomyService } from '../../../src/common/services/skill-taxonomy.service';
import { SkillNormalizerService } from '../../../src/common/services/skill-normalizer.service';
import { SkillTextScannerService } from '../../../src/common/services/skill-text-scanner.service';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeRes(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

// ─── GithubClientService ─────────────────────────────────────────────────────

describe('GithubClientService', () => {
  // Save global.fetch before any mocking so we can restore it.
  const realFetch = global.fetch;
  let client: GithubClientService;

  beforeEach(() => {
    // Fresh client per test so the in-memory cache is empty.
    client = new GithubClientService({ get: jest.fn().mockReturnValue('tok') } as never);
  });

  afterEach(() => {
    // Restore fetch so other test suites aren't poisoned.
    global.fetch = realFetch;
  });

  it('happy path: 200 → returns correctly typed GithubRepo[] with Authorization header', async () => {
    const rawRepos = [
      {
        name: 'my-app',
        html_url: 'https://github.com/u/my-app',
        fork: false,
        language: 'TypeScript',
        topics: ['react', 'web'],
        description: 'A sample app',
        pushed_at: '2026-01-01T00:00:00Z',
        stargazers_count: 999, // extra field — must be ignored
      },
    ];

    const mockFetch = jest.fn().mockResolvedValue(makeRes(200, rawRepos));
    global.fetch = mockFetch;

    const repos = await client.fetchPublicRepos('someuser');

    expect(repos).toHaveLength(1);
    expect(repos[0].name).toBe('my-app');
    expect(repos[0].language).toBe('TypeScript');
    expect(repos[0].fork).toBe(false);
    expect(repos[0].topics).toEqual(['react', 'web']);
    expect(repos[0].description).toBe('A sample app');
    expect(repos[0].pushed_at).toBe('2026-01-01T00:00:00Z');
    // Ensure stars are absent — GithubRepo type has no stargazers_count
    expect((repos[0] as unknown as Record<string, unknown>).stargazers_count).toBeUndefined();

    // Assert request headers
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/users/someuser/repos');
    expect((init?.headers as Record<string, string>)?.['User-Agent']).toMatch(/SkillBridgeBot/);
    expect((init?.headers as Record<string, string>)?.['Authorization']).toBe('Bearer tok');
  });

  it('no token: Authorization header is absent', async () => {
    client = new GithubClientService({ get: jest.fn().mockReturnValue(undefined) } as never);
    const mockFetch = jest.fn().mockResolvedValue(makeRes(200, []));
    global.fetch = mockFetch;

    await client.fetchPublicRepos('notoken');

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init?.headers as Record<string, string>)?.['Authorization']).toBeUndefined();
  });

  it('404 → throws GithubUserNotFoundError', async () => {
    global.fetch = jest.fn().mockResolvedValue(makeRes(404, { message: 'Not Found' }));
    await expect(client.fetchPublicRepos('ghost')).rejects.toBeInstanceOf(GithubUserNotFoundError);
  });

  it('403 → throws GithubRateLimitError', async () => {
    global.fetch = jest.fn().mockResolvedValue(makeRes(403, { message: 'Forbidden' }));
    await expect(client.fetchPublicRepos('user')).rejects.toBeInstanceOf(GithubRateLimitError);
  });

  it('429 → throws GithubRateLimitError', async () => {
    global.fetch = jest.fn().mockResolvedValue(makeRes(429, {}));
    await expect(client.fetchPublicRepos('user')).rejects.toBeInstanceOf(GithubRateLimitError);
  });

  it('fetch throw → throws GithubFetchError', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network down'));
    await expect(client.fetchPublicRepos('user')).rejects.toBeInstanceOf(GithubFetchError);
  });

  it('cache: two calls same username (case-insensitive) → only ONE actual fetch', async () => {
    const mockFetch = jest.fn().mockResolvedValue(makeRes(200, []));
    global.fetch = mockFetch;

    await client.fetchPublicRepos('TestUser');
    await client.fetchPublicRepos('testuser'); // same key after .toLowerCase()

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ─── GithubEvidenceService ───────────────────────────────────────────────────

describe('GithubEvidenceService', () => {
  let normalizer: SkillNormalizerService;
  let scanner: SkillTextScannerService;
  let mockClient: jest.Mocked<Pick<GithubClientService, 'fetchPublicRepos'>>;
  let service: GithubEvidenceService;

  beforeAll(async () => {
    // Boot REAL taxonomy + normalizer + scanner — no LLM, no DB.
    const taxonomy = new SkillTaxonomyService();
    await taxonomy.onModuleInit();
    normalizer = new SkillNormalizerService(taxonomy);
    scanner = new SkillTextScannerService(taxonomy);
    scanner.onModuleInit();
  });

  beforeEach(() => {
    mockClient = { fetchPublicRepos: jest.fn() };
    service = new GithubEvidenceService(
      mockClient as unknown as GithubClientService,
      normalizer,
      scanner,
    );
  });

  it('consent=false → CONSENT_REQUIRED, client never called', async () => {
    const result = await service.build({ username: 'someuser', consent: false, review: null });
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toBe('CONSENT_REQUIRED');
    expect(mockClient.fetchPublicRepos).not.toHaveBeenCalled();
  });

  it('username "-bad-" (leading/trailing hyphen) → INVALID_USERNAME', async () => {
    const result = await service.build({ username: '-bad-', consent: true, review: null });
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toBe('INVALID_USERNAME');
    expect(mockClient.fetchPublicRepos).not.toHaveBeenCalled();
  });

  it('empty username → INVALID_USERNAME', async () => {
    const result = await service.build({ username: '  ', consent: true, review: null });
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toBe('INVALID_USERNAME');
  });

  it('client throws GithubUserNotFoundError → USER_NOT_FOUND', async () => {
    mockClient.fetchPublicRepos.mockRejectedValue(new GithubUserNotFoundError('ghost'));
    const result = await service.build({ username: 'ghost', consent: true, review: null });
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toBe('USER_NOT_FOUND');
  });

  it('client throws GithubRateLimitError → RATE_LIMITED', async () => {
    mockClient.fetchPublicRepos.mockRejectedValue(new GithubRateLimitError('429'));
    const result = await service.build({ username: 'user', consent: true, review: null });
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toBe('RATE_LIMITED');
  });

  it('client throws generic error → FETCH_FAILED', async () => {
    mockClient.fetchPublicRepos.mockRejectedValue(new Error('timeout'));
    const result = await service.build({ username: 'user', consent: true, review: null });
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toBe('FETCH_FAILED');
  });

  it('happy: TypeScript repo named react-app + review with react in ledger → available, react in corroborated, typescript in github_only', async () => {
    mockClient.fetchPublicRepos.mockResolvedValue([
      {
        name: 'react-app',
        html_url: 'https://github.com/u/react-app',
        fork: false,
        language: 'TypeScript',
        topics: [],
        description: null,
        pushed_at: '2026-03-01T00:00:00Z',
      },
    ]);

    // Minimal CvReviewParsedResponse cast — only evidence_ledger.items is used.
    const review = {
      evidence_ledger: {
        items: [{ skill_canonical: 'react', display_name: 'React', strength: 'demonstrated', source_refs: [], in_skills_section: true }],
        evidence_gap: [],
      },
    } as unknown as CvReviewParsedResponse;

    const result = await service.build({ username: 'testuser', consent: true, review, lang: 'en' });

    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.cv_skill_join).toBe(true);
      expect(result.username).toBe('testuser');
      expect(result.analyzed_repo_count).toBe(1);
      // react is in the CV ledger and in the repo name (scanned) → corroborated
      expect(result.corroborated.map((s) => s.skill_canonical)).toContain('react');
      // typescript (the language) is not in the CV ledger → github_only
      expect(result.github_only.map((s) => s.skill_canonical)).toContain('typescript');
    }
  });

  it('review null → cv_skill_join=false, all findings land in github_only', async () => {
    mockClient.fetchPublicRepos.mockResolvedValue([
      {
        name: 'docker-utils',
        html_url: 'https://github.com/u/docker-utils',
        fork: false,
        language: 'Python',
        topics: ['docker'],
        description: null,
        pushed_at: '2025-12-01T00:00:00Z',
      },
    ]);

    const result = await service.build({ username: 'someone', consent: true, review: null, lang: 'vi' });

    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.cv_skill_join).toBe(false);
      expect(result.corroborated).toEqual([]);
      // docker and python should appear in github_only (real taxonomy matches)
      expect(result.github_only.length).toBeGreaterThan(0);
    }
  });
});

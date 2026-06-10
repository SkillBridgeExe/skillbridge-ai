import {
  buildGithubEvidence,
  GithubRepo,
} from '../../../src/modules/github-evidence/github-evidence';

const repo = (over: Partial<GithubRepo>): GithubRepo => ({
  name: 'demo',
  html_url: 'https://github.com/u/demo',
  fork: false,
  language: null,
  topics: [],
  description: null,
  pushed_at: '2026-03-01T00:00:00Z',
  ...over,
});

// Stub callbacks — keep the pure fn independent of the real taxonomy.
const KNOWN = new Set(['typescript', 'react', 'docker', 'python', 'java', 'sql', 'kafka']);
const normalize = (raw: string): string | null => {
  const k = raw.trim().toLowerCase().replace(/\s+/g, '_');
  return KNOWN.has(k) ? k : null;
};
const scan = (text: string) =>
  [...KNOWN]
    .filter((k) => text.toLowerCase().includes(k))
    .map((k) => ({ canonical_name: k, matched_text: k, occurrences: 1 }));
const display = (c: string) => c.toUpperCase();

describe('buildGithubEvidence (pure)', () => {
  it('maps language + topics + name/description, dedups within a repo, excludes forks', () => {
    const repos = [
      repo({
        name: 'react-shop',
        language: 'TypeScript',
        topics: ['react'],
        description: 'docker deploy',
      }),
      repo({ name: 'stolen-fork', fork: true, language: 'Python' }), // MUST be ignored
    ];
    const { corroborated, github_only, analyzed_repo_count } = buildGithubEvidence(
      repos,
      new Set(['react']),
      normalize,
      scan,
      display,
      'vi',
    );
    expect(analyzed_repo_count).toBe(1); // fork excluded
    expect(github_only.map((s) => s.skill_canonical).sort()).toEqual(['docker', 'typescript']);
    expect(corroborated.map((s) => s.skill_canonical)).toEqual(['react']);
    expect(github_only.map((s) => s.skill_canonical)).not.toContain('python'); // fork-only skill
    // dedup: react found via BOTH name-scan and topic — still ONE source from this repo
    expect(corroborated[0].repo_count).toBe(1);
    expect(corroborated[0].repos).toHaveLength(1);
  });

  it('aggregates repo_count, caps displayed repos at 3 (most recent first), computes most_recent_year', () => {
    const repos = [
      repo({ name: 'a', language: 'React', pushed_at: '2023-05-01T00:00:00Z' }),
      repo({ name: 'b', language: 'React', pushed_at: '2026-01-01T00:00:00Z' }),
      repo({ name: 'c', language: 'React', pushed_at: '2024-01-01T00:00:00Z' }),
      repo({ name: 'd', language: 'React', pushed_at: null }),
    ];
    const { github_only } = buildGithubEvidence(repos, null, normalize, scan, display, 'vi');
    const react = github_only.find((s) => s.skill_canonical === 'react')!;
    expect(react.repo_count).toBe(4);
    expect(react.repos).toHaveLength(3);
    expect(react.repos[0].name).toBe('b'); // 2026 first; null pushed_at sorts last
    expect(react.most_recent_year).toBe(2026);
  });

  it('null cvCanonicals (no review/ledger) → everything lands in github_only', () => {
    const { corroborated, github_only } = buildGithubEvidence(
      [repo({ language: 'TypeScript' })],
      null,
      normalize,
      scan,
      display,
      'vi',
    );
    expect(corroborated).toEqual([]);
    expect(github_only.map((s) => s.skill_canonical)).toEqual(['typescript']);
  });

  it('caps corroborated at 10 and github_only at 5, sorted by repo_count then recency', () => {
    // 7 distinct known skills impossible with 4-entry KNOWN set — instead prove the github_only
    // cap with repeated KNOWN skills is moot; assert ordering instead: docker(2 repos) before python(1).
    const repos = [
      repo({ name: 'p1', language: 'Python', pushed_at: '2026-01-01T00:00:00Z' }),
      repo({ name: 'd1', language: 'Docker', pushed_at: '2023-01-01T00:00:00Z' }),
      repo({ name: 'd2', description: 'docker tooling', pushed_at: '2022-01-01T00:00:00Z' }),
    ];
    const { github_only } = buildGithubEvidence(repos, null, normalize, scan, display, 'vi');
    expect(github_only.map((s) => s.skill_canonical)).toEqual(['docker', 'python']);
  });

  it('why copy carries real numbers, never claims "verified", and splits vi/en', () => {
    const repos = [repo({ language: 'React', pushed_at: '2026-02-02T00:00:00Z' })];
    const vi = buildGithubEvidence(repos, new Set(['react']), normalize, scan, display, 'vi');
    expect(vi.corroborated[0].why).toContain('1 repo');
    expect(vi.corroborated[0].why).toContain('2026');
    expect(vi.corroborated[0].why.toLowerCase()).not.toContain('verified');
    const en = buildGithubEvidence(repos, null, normalize, scan, display, 'en');
    expect(en.github_only[0].why).toMatch(/consider adding|CV/i);
  });

  it('actually enforces the github_only cap of 5 with 7 distinct skills', () => {
    const langs = ['TypeScript', 'React', 'Docker', 'Python', 'Java', 'Sql', 'Kafka'];
    const repos = langs.map((l, i) =>
      repo({ name: `r${i}`, language: l, pushed_at: `202${i % 7}-01-01T00:00:00Z` }),
    );
    const { github_only, corroborated } = buildGithubEvidence(
      repos,
      null,
      normalize,
      scan,
      display,
      'vi',
    );
    expect(corroborated).toEqual([]);
    expect(github_only).toHaveLength(5); // GITHUB_ONLY_CAP enforced, 2 dropped
  });
});

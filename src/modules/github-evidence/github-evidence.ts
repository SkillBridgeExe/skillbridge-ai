import { ScannedSkill } from '../../common/services/skill-text-scanner.service';

/** The ONLY fields we read from the GitHub API. stars/forks counts are deliberately ABSENT
 *  (gameable signals — design rule, do not add them). */
export interface GithubRepo {
  name: string;
  html_url: string;
  fork: boolean;
  language: string | null;
  topics: string[];
  description: string | null;
  pushed_at: string | null;
}

export interface GithubSkillEvidence {
  skill_canonical: string;
  display_name: string;
  /** Display sample — most recent first, capped at 3. repo_count is the real total. */
  repos: Array<{ name: string; url: string; pushed_year: number | null }>;
  repo_count: number;
  most_recent_year: number | null;
  /** vi/en, real numbers, "handle bạn cung cấp" framing — NEVER the word "verified". */
  why: string;
}

export const CORROBORATED_CAP = 10;
export const GITHUB_ONLY_CAP = 5;
const REPOS_SHOWN_PER_SKILL = 3;

type Lang = 'vi' | 'en';
const T = {
  vi: {
    corroborated: (s: string, n: number, y: number | null) =>
      `${n} repo public (handle bạn cung cấp)${y ? `, hoạt động gần nhất ${y},` : ''} có ${s} — bằng chứng code thật củng cố cho CV.`,
    githubOnly: (s: string, n: number) =>
      `GitHub của handle này có ${n} repo dùng ${s} nhưng CV chưa nhắc — nếu đúng là của bạn, cân nhắc thêm vào CV.`,
  },
  en: {
    corroborated: (s: string, n: number, y: number | null) =>
      `${n} public repo(s) on the handle you provided${y ? ` (last active ${y})` : ''} use ${s} — real code backing the CV.`,
    githubOnly: (s: string, n: number) =>
      `This handle has ${n} repo(s) using ${s} that the CV never mentions — if it's yours, consider adding it to the CV.`,
  },
} as const;

function pushedYear(pushed_at: string | null): number | null {
  if (!pushed_at) return null;
  const m = pushed_at.match(/^(\d{4})/);
  return m ? Number(m[1]) : null;
}

/**
 * Deterministic GitHub → skill-evidence mapping. NO LLM. Per non-fork repo, skills come from
 * the primary language + topics (normalized) + a gazetteer scan of name/description; the join
 * vs the CV's canonicals splits corroborated (CV claims it AND code shows it) from github_only
 * (code shows it, CV silent). Stars/forks are never read. Display-only — feeds NO score.
 */
export function buildGithubEvidence(
  repos: GithubRepo[],
  cvCanonicals: Set<string> | null,
  normalize: (raw: string) => string | null,
  scan: (text: string) => ScannedSkill[],
  resolveDisplay: (canonical: string) => string,
  lang: Lang,
): {
  corroborated: GithubSkillEvidence[];
  github_only: GithubSkillEvidence[];
  analyzed_repo_count: number;
} {
  const t = T[lang];
  const byCanonical = new Map<string, Array<{ name: string; url: string; pushed_year: number | null }>>();
  let analyzed = 0;

  for (const r of repos) {
    if (r.fork) continue;
    analyzed++;
    const found = new Set<string>();
    const lang_ = r.language ? normalize(r.language) : null;
    if (lang_) found.add(lang_);
    for (const topic of r.topics ?? []) {
      const c = normalize(topic);
      if (c) found.add(c);
    }
    for (const hit of scan(`${r.name} ${r.description ?? ''}`)) found.add(hit.canonical_name);
    for (const c of found) {
      const list = byCanonical.get(c) ?? [];
      list.push({ name: r.name, url: r.html_url, pushed_year: pushedYear(r.pushed_at) });
      byCanonical.set(c, list);
    }
  }

  const items: GithubSkillEvidence[] = [...byCanonical.entries()].map(([canonical, sources]) => {
    const sorted = [...sources].sort((a, b) => (b.pushed_year ?? -1) - (a.pushed_year ?? -1));
    const years = sorted.map((s) => s.pushed_year).filter((y): y is number => y !== null);
    const most_recent_year = years.length ? years[0] : null;
    return {
      skill_canonical: canonical,
      display_name: resolveDisplay(canonical),
      repos: sorted.slice(0, REPOS_SHOWN_PER_SKILL),
      repo_count: sources.length,
      most_recent_year,
      why: '', // filled after the corroborated/github_only split (copy differs)
    };
  });

  const order = (a: GithubSkillEvidence, b: GithubSkillEvidence) =>
    b.repo_count - a.repo_count ||
    (b.most_recent_year ?? -1) - (a.most_recent_year ?? -1) ||
    a.skill_canonical.localeCompare(b.skill_canonical);

  const corroborated = items
    .filter((i) => cvCanonicals?.has(i.skill_canonical) ?? false)
    .sort(order)
    .slice(0, CORROBORATED_CAP)
    .map((i) => ({ ...i, why: t.corroborated(i.display_name, i.repo_count, i.most_recent_year) }));
  const github_only = items
    .filter((i) => !(cvCanonicals?.has(i.skill_canonical) ?? false))
    .sort(order)
    .slice(0, GITHUB_ONLY_CAP)
    .map((i) => ({ ...i, why: t.githubOnly(i.display_name, i.repo_count) }));

  return { corroborated, github_only, analyzed_repo_count: analyzed };
}

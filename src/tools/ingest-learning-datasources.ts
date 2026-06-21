/**
 * Datasource v2 seed/ingest for metadata-only learning resources.
 *
 * This tool writes explicit resources into data/learning-resource-catalog.json as `pending`.
 * It never stores full course/article content: only title, link, provider, skill metadata, and a
 * short human-authored/source-metadata description. Run curation afterwards to verify/promote.
 */
import * as dotenv from 'dotenv';
const dotenvParsed = dotenv.config().parsed ?? {};
if (dotenvParsed.YOUTUBE_API_KEY) process.env.YOUTUBE_API_KEY = dotenvParsed.YOUTUBE_API_KEY;
if (dotenvParsed.GITHUB_TOKEN) process.env.GITHUB_TOKEN = dotenvParsed.GITHUB_TOKEN;

import * as fs from 'fs';
import * as path from 'path';
import {
  LearningResource,
  ResourceDifficulty,
  ResourceSourceType,
  coerceLearningResources,
} from '../modules/roadmap/learning-resource';

type Seed = Omit<
  LearningResource,
  | 'source_type'
  | 'difficulty'
  | 'outcome_type'
  | 'quality_score'
  | 'freshness_score'
  | 'last_verified_at'
  | 'validation_status'
> & {
  difficulty?: ResourceDifficulty;
  source_type?: ResourceSourceType;
  outcome_type?: LearningResource['outcome_type'];
};

interface Args {
  apply: boolean;
}

interface MsLearnModule {
  title: string;
  url: string;
  duration_in_minutes?: number;
  products?: string[];
  subjects?: string[];
  levels?: string[];
}

interface YouTubeSearchItem {
  id?: { videoId?: string };
  snippet?: {
    title?: string;
    channelTitle?: string;
    description?: string;
  };
}

interface YouTubeVideoItem {
  id?: string;
  contentDetails?: { duration?: string };
}

interface GithubRepo {
  html_url?: string;
  description?: string;
}

const TODAY = '2026-06-21';

function parseArgs(argv: string[]): Args {
  return { apply: argv.includes('--apply') };
}

const source = (input: Seed): LearningResource => ({
  ...input,
  source_type: input.source_type ?? 'official_doc',
  difficulty: input.difficulty ?? 'BEGINNER',
  outcome_type: input.outcome_type ?? 'understand',
  quality_score: 0,
  freshness_score: 100,
  last_verified_at: TODAY,
  validation_status: 'pending',
});

function staticSeeds(): LearningResource[] {
  return [
    source({
      id: 'reactdev-learn-quick-start',
      title: 'React Quick Start',
      provider: 'react.dev',
      url: 'https://react.dev/learn',
      is_internal: false,
      language: 'en',
      duration_minutes: 90,
      is_free: true,
      skills: [{ skill_canonical_name: 'react', teaches_level: 3 }],
      description: 'Official React learning guide for components, JSX, props, and state basics.',
    }),
    source({
      id: 'f8-reactjs-course',
      title: 'ReactJS Course',
      provider: 'fullstack.edu.vn',
      url: 'https://fullstack.edu.vn/courses/reactjs',
      is_internal: false,
      language: 'vi',
      duration_minutes: 360,
      is_free: true,
      skills: [{ skill_canonical_name: 'react', teaches_level: 3 }],
      description:
        'Vietnamese React course landing page from F8, manually seeded as metadata and link only.',
    }),
    source({
      id: 'typescriptlang-handbook',
      title: 'TypeScript Handbook',
      provider: 'typescriptlang.org',
      url: 'https://www.typescriptlang.org/docs/handbook/intro.html',
      is_internal: false,
      language: 'en',
      duration_minutes: 240,
      is_free: true,
      skills: [{ skill_canonical_name: 'typescript', teaches_level: 3 }],
      description:
        'Official TypeScript handbook covering language basics, types, and everyday usage.',
    }),
    source({
      id: 'mdn-javascript-guide',
      title: 'JavaScript Guide',
      provider: 'MDN Web Docs',
      url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide',
      is_internal: false,
      language: 'en',
      duration_minutes: 300,
      is_free: true,
      skills: [{ skill_canonical_name: 'javascript', teaches_level: 3 }],
      description: 'MDN guide for core JavaScript syntax, control flow, objects, and functions.',
    }),
    source({
      id: 'f8-javascript-basic',
      title: 'JavaScript Basic Course',
      provider: 'fullstack.edu.vn',
      url: 'https://fullstack.edu.vn/courses/javascript-co-ban',
      is_internal: false,
      language: 'vi',
      duration_minutes: 360,
      is_free: true,
      skills: [{ skill_canonical_name: 'javascript', teaches_level: 3 }],
      description:
        'Vietnamese JavaScript basics course from F8, manually seeded as metadata and link only.',
    }),
    source({
      id: 'nodejs-learn-introduction',
      title: 'Introduction to Node.js',
      provider: 'nodejs.org',
      url: 'https://nodejs.org/en/learn/getting-started/introduction-to-nodejs',
      is_internal: false,
      language: 'en',
      duration_minutes: 90,
      is_free: true,
      skills: [{ skill_canonical_name: 'node_js', teaches_level: 3 }],
      description: 'Official Node.js learning material for getting started with the runtime.',
    }),
    source({
      id: 'f8-nodejs-express-course',
      title: 'NodeJS & ExpressJS Course',
      provider: 'fullstack.edu.vn',
      url: 'https://fullstack.edu.vn/courses/nodejs',
      is_internal: false,
      language: 'vi',
      duration_minutes: 420,
      is_free: true,
      skills: [{ skill_canonical_name: 'node_js', teaches_level: 3 }],
      description:
        'Vietnamese Node.js and Express course from F8, manually seeded as metadata and link only.',
    }),
    source({
      id: 'spring-guides-building-rest-service',
      title: 'Building a RESTful Web Service',
      provider: 'spring.io',
      url: 'https://spring.io/guides/gs/rest-service/',
      is_internal: false,
      language: 'en',
      duration_minutes: 120,
      is_free: true,
      skills: [
        { skill_canonical_name: 'java', teaches_level: 3 },
        { skill_canonical_name: 'spring_boot', teaches_level: 3 },
        { skill_canonical_name: 'rest_api', teaches_level: 3 },
      ],
      description:
        'Official Spring guide for building a simple REST service with Java and Spring Boot.',
    }),
    source({
      id: 'docs-python-tutorial',
      title: 'The Python Tutorial',
      provider: 'docs.python.org',
      url: 'https://docs.python.org/3/tutorial/',
      is_internal: false,
      language: 'en',
      duration_minutes: 300,
      is_free: true,
      skills: [{ skill_canonical_name: 'python', teaches_level: 3 }],
      description:
        'Official Python tutorial covering syntax, data structures, modules, and classes.',
    }),
    source({
      id: 'sqlbolt-interactive-sql-lessons',
      title: 'SQLBolt Interactive Lessons',
      provider: 'sqlbolt.com',
      url: 'https://sqlbolt.com/',
      is_internal: false,
      language: 'en',
      duration_minutes: 180,
      is_free: true,
      skills: [{ skill_canonical_name: 'sql', teaches_level: 3 }],
      description:
        'Interactive SQL lesson set for select queries, joins, aggregation, and table operations.',
    }),
    source({
      id: 'postgresql-official-tutorial-docs',
      title: 'PostgreSQL Tutorial',
      provider: 'postgresql.org',
      url: 'https://www.postgresql.org/docs/current/tutorial.html',
      is_internal: false,
      language: 'en',
      duration_minutes: 180,
      is_free: true,
      skills: [{ skill_canonical_name: 'postgresql', teaches_level: 3 }],
      description:
        'Official PostgreSQL tutorial for relational concepts, SQL, and database basics.',
    }),
    source({
      id: 'docker-official-get-started',
      title: 'Docker Get Started',
      provider: 'docs.docker.com',
      url: 'https://docs.docker.com/get-started/',
      is_internal: false,
      language: 'en',
      duration_minutes: 60,
      is_free: true,
      skills: [{ skill_canonical_name: 'docker', teaches_level: 3 }],
      description:
        'Official Docker onboarding documentation covering basic container concepts and first steps.',
    }),
    source({
      id: 'git-scm-book',
      title: 'Pro Git Book',
      provider: 'git-scm.com',
      url: 'https://git-scm.com/book/en/v2',
      is_internal: false,
      language: 'en',
      duration_minutes: 420,
      is_free: true,
      skills: [{ skill_canonical_name: 'git', teaches_level: 3 }],
      description:
        'Officially hosted Pro Git book covering Git basics, branching, remotes, and workflows.',
    }),
    source({
      id: 'f8-html-css-course',
      title: 'HTML CSS Course',
      provider: 'fullstack.edu.vn',
      url: 'https://fullstack.edu.vn/courses/html-css',
      is_internal: false,
      language: 'vi',
      duration_minutes: 420,
      is_free: true,
      skills: [
        { skill_canonical_name: 'html', teaches_level: 3 },
        { skill_canonical_name: 'css', teaches_level: 3 },
      ],
      description:
        'Vietnamese HTML and CSS course from F8, manually seeded as metadata and link only.',
    }),
    source({
      id: 'mdn-learn-html-css',
      title: 'MDN Learn Web Development',
      provider: 'MDN Web Docs',
      url: 'https://developer.mozilla.org/en-US/docs/Learn',
      is_internal: false,
      language: 'en',
      duration_minutes: 480,
      is_free: true,
      skills: [
        { skill_canonical_name: 'html', teaches_level: 3 },
        { skill_canonical_name: 'css', teaches_level: 3 },
      ],
      description: 'MDN learning area for HTML, CSS, JavaScript, and foundational web development.',
    }),
    source({
      id: 'topcv-cv-writing-guide',
      title: 'CV Writing Guide',
      provider: 'topcv.vn',
      url: 'https://www.topcv.vn/huong-dan-viet-cv',
      is_internal: false,
      language: 'vi',
      duration_minutes: 60,
      is_free: true,
      skills: [{ skill_canonical_name: 'cv_writing', teaches_level: 3 }],
      outcome_type: 'cv_improvement',
      description: 'Vietnamese CV writing guidance from TopCV, seeded as metadata and link only.',
    }),
    source({
      id: 'talkfirst-english-interview',
      title: 'English Interview Practice',
      provider: 'talkfirst.vn',
      url: 'https://talkfirst.vn/phong-van-tieng-anh/',
      is_internal: false,
      language: 'vi',
      duration_minutes: 90,
      is_free: true,
      skills: [
        { skill_canonical_name: 'english_proficiency', teaches_level: 3 },
        { skill_canonical_name: 'communication', teaches_level: 3 },
      ],
      outcome_type: 'interview_answer',
      description: 'Vietnamese landing resource for practicing English interview communication.',
    }),
    source({
      id: 'system-design-primer-github',
      title: 'System Design Primer',
      provider: 'github.com/donnemartin/system-design-primer',
      url: 'https://github.com/donnemartin/system-design-primer',
      is_internal: false,
      language: 'en',
      duration_minutes: 600,
      is_free: true,
      skills: [{ skill_canonical_name: 'system_design', teaches_level: 3 }],
      difficulty: 'INTERMEDIATE',
      outcome_type: 'interview_answer',
      description:
        'Public GitHub system design study guide for interview practice and architecture basics.',
    }),
    source({
      id: 'deeplearningai-langchain-short-course',
      title: 'LangChain for LLM Application Development',
      provider: 'DeepLearning.AI',
      url: 'https://www.deeplearning.ai/short-courses/langchain-for-llm-application-development/',
      is_internal: false,
      language: 'en',
      duration_minutes: 90,
      is_free: true,
      skills: [{ skill_canonical_name: 'llm_engineering', teaches_level: 3 }],
      difficulty: 'INTERMEDIATE',
      description:
        'Free short course introducing LangChain patterns for LLM application development.',
    }),
  ];
}

async function fetchMsLearnDotnet(): Promise<LearningResource | null> {
  const res = await fetch('https://learn.microsoft.com/api/catalog/?locale=en-us&type=modules');
  if (!res.ok) return null;
  const json = (await res.json()) as { modules?: MsLearnModule[] };
  const module = (json.modules ?? []).find((item) => {
    const haystack =
      `${item.title} ${(item.products ?? []).join(' ')} ${(item.subjects ?? []).join(' ')}`.toLowerCase();
    return haystack.includes('c#') || haystack.includes('asp.net') || haystack.includes('dotnet');
  });
  if (!module) return null;
  return source({
    id: 'mslearn-dotnet-csharp-module',
    title: module.title,
    provider: 'learn.microsoft.com',
    url: module.url,
    is_internal: false,
    language: 'en',
    duration_minutes: module.duration_in_minutes ?? 120,
    difficulty: module.levels?.includes('advanced')
      ? 'ADVANCED'
      : module.levels?.includes('intermediate')
        ? 'INTERMEDIATE'
        : 'BEGINNER',
    is_free: true,
    skills: [{ skill_canonical_name: 'dotnet', teaches_level: 3 }],
    description:
      'Microsoft Learn catalog module for .NET/C# learning, selected via the public catalog API.',
  });
}

function xmlText(value: string): string {
  return value
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function firstTag(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(block);
  return match ? xmlText(match[1]) : null;
}

async function fetchOfficialDocsSitemapSeed(): Promise<LearningResource | null> {
  const res = await fetch('https://docs.docker.com/sitemap.xml');
  if (!res.ok) return null;
  const xml = await res.text();
  const urls = [...xml.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)].map((match) => xmlText(match[1]));
  const url = urls.find((item) => item === 'https://docs.docker.com/get-started/');
  if (!url) return null;
  return source({
    id: 'docker-official-get-started',
    title: 'Docker Get Started',
    provider: 'docs.docker.com',
    url,
    is_internal: false,
    language: 'en',
    duration_minutes: 60,
    is_free: true,
    skills: [{ skill_canonical_name: 'docker', teaches_level: 3 }],
    description:
      'Official Docker onboarding documentation selected from the docs.docker.com sitemap metadata.',
  });
}

async function fetchVibloRssSeed(): Promise<LearningResource | null> {
  const res = await fetch('https://viblo.asia/rss');
  if (!res.ok) return null;
  const xml = await res.text();
  const items = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((match) => match[0]);
  const item = items.find((block) => {
    const haystack =
      `${firstTag(block, 'title') ?? ''} ${firstTag(block, 'description') ?? ''}`.toLowerCase();
    return (
      haystack.includes('react') ||
      haystack.includes('javascript') ||
      haystack.includes('node') ||
      haystack.includes('docker') ||
      haystack.includes('typescript')
    );
  });
  if (!item) return null;
  const title = firstTag(item, 'title');
  const link = firstTag(item, 'link');
  if (!title || !link) return null;
  const lower = `${title} ${firstTag(item, 'description') ?? ''}`.toLowerCase();
  const skill = lower.includes('react')
    ? 'react'
    : lower.includes('typescript')
      ? 'typescript'
      : lower.includes('node')
        ? 'node_js'
        : lower.includes('docker')
          ? 'docker'
          : 'javascript';
  return source({
    id: `viblo-rss-${skill}-${Buffer.from(link).toString('base64url').slice(0, 12)}`,
    title,
    provider: 'viblo.asia',
    url: link,
    source_type: 'official_doc',
    is_internal: false,
    language: 'vi',
    duration_minutes: 45,
    is_free: true,
    skills: [{ skill_canonical_name: skill, teaches_level: 2 }],
    description:
      'Vietnamese article metadata discovered from the Viblo RSS feed. Kept pending for human review because Viblo is user-generated content.',
  });
}

function isoDurationMinutes(value: string | undefined): number {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value ?? '');
  if (!match) return 30;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  return Math.max(1, hours * 60 + minutes + Math.ceil(seconds / 60));
}

async function fetchYouTubeEnglishInterview(): Promise<LearningResource | null> {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return null;
  const query = new URLSearchParams({
    part: 'snippet',
    q: 'software engineer interview English practice',
    type: 'video',
    videoEmbeddable: 'true',
    maxResults: '1',
    relevanceLanguage: 'en',
    key,
  });
  const searchRes = await fetch(`https://www.googleapis.com/youtube/v3/search?${query}`);
  if (!searchRes.ok) return null;
  const search = (await searchRes.json()) as { items?: YouTubeSearchItem[] };
  const videoId = search.items?.[0]?.id?.videoId;
  const snippet = search.items?.[0]?.snippet;
  if (!videoId || !snippet?.title) return null;

  const detailQuery = new URLSearchParams({
    part: 'contentDetails',
    id: videoId,
    key,
  });
  const detailRes = await fetch(`https://www.googleapis.com/youtube/v3/videos?${detailQuery}`);
  const detail = detailRes.ok ? ((await detailRes.json()) as { items?: YouTubeVideoItem[] }) : {};
  return source({
    id: `youtube-english-interview-${videoId}`,
    title: snippet.title,
    provider: `YouTube - ${snippet.channelTitle ?? 'unknown channel'}`,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    source_type: 'video',
    is_internal: false,
    language: 'en',
    duration_minutes: isoDurationMinutes(detail.items?.[0]?.contentDetails?.duration),
    is_free: true,
    skills: [
      { skill_canonical_name: 'english_proficiency', teaches_level: 3 },
      { skill_canonical_name: 'communication', teaches_level: 3 },
    ],
    outcome_type: 'interview_answer',
    description:
      snippet.description?.slice(0, 240) ||
      'YouTube metadata result for English interview communication practice.',
  });
}

async function fetchGithubMetadataSeed(): Promise<LearningResource | null> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'skillbridge-learning-datasource',
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch('https://api.github.com/repos/freeCodeCamp/freeCodeCamp', { headers });
  if (!res.ok) return null;
  const repo = (await res.json()) as GithubRepo;
  return source({
    id: 'github-freecodecamp-curriculum',
    title: 'freeCodeCamp Curriculum',
    provider: 'freeCodeCamp GitHub',
    url: repo.html_url ?? 'https://github.com/freeCodeCamp/freeCodeCamp',
    source_type: 'course',
    is_internal: false,
    language: 'en',
    duration_minutes: 600,
    is_free: true,
    skills: [
      { skill_canonical_name: 'javascript', teaches_level: 3 },
      { skill_canonical_name: 'html', teaches_level: 3 },
      { skill_canonical_name: 'css', teaches_level: 3 },
    ],
    description:
      repo.description?.slice(0, 240) ||
      'Public freeCodeCamp curriculum repository metadata for web development learning.',
  });
}

function mergeResources(
  existing: LearningResource[],
  incoming: LearningResource[],
): LearningResource[] {
  const byId = new Map<string, LearningResource>();
  for (const resource of existing) byId.set(resource.id, resource);
  for (const resource of incoming) byId.set(resource.id, resource);
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const file = path.join(process.cwd(), 'data', 'learning-resource-catalog.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
    resources?: unknown;
    [key: string]: unknown;
  };
  const existing = coerceLearningResources(parsed.resources);
  const dynamic = await Promise.all([
    fetchMsLearnDotnet().catch(() => null),
    fetchOfficialDocsSitemapSeed().catch(() => null),
    fetchVibloRssSeed().catch(() => null),
    fetchYouTubeEnglishInterview().catch(() => null),
    fetchGithubMetadataSeed().catch(() => null),
  ]);
  const incoming = [
    ...staticSeeds(),
    ...dynamic.filter((item): item is LearningResource => !!item),
  ];
  const merged = mergeResources(existing, incoming);
  const valid = coerceLearningResources(merged);
  if (valid.length !== merged.length)
    throw new Error('Generated resources failed catalog coercion');

  console.log(
    `Datasource v2 ingest: ${existing.length} existing + ${incoming.length} incoming -> ${merged.length} resources (${args.apply ? 'apply' : 'dry-run'}).`,
  );
  const byLang = merged.reduce<Record<string, number>>((acc, resource) => {
    acc[resource.language] = (acc[resource.language] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`Languages: ${JSON.stringify(byLang)}`);
  if (!args.apply) {
    console.log('Dry-run only. Pass --apply to write data/learning-resource-catalog.json.');
    return;
  }
  fs.writeFileSync(file, `${JSON.stringify({ ...parsed, resources: merged }, null, 2)}\n`);
  console.log(`Wrote ${file}.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`ingest failed: ${(err as Error).message}`);
    process.exit(1);
  });
}

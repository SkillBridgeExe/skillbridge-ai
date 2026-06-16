/**
 * Pure normalization helpers for the JD ingest pipeline (no DB, no I/O — fully unit-testable).
 *
 * LEGAL POSTURE (PDPL 91/2025 + copyright, see docs/jd-pool-research.md):
 *  - scrubPii MUST run before any JD text is used for extraction or ever leaves the process:
 *    recruiter emails/phones/handles inside a JD ARE personal data under PDPL.
 *  - The pipeline never persists JD full text — only extracted skills + metadata + source link.
 */

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
/** zalo/skype/telegram handles often written "Zalo: 09xx" or "skype: live:abc". */
const HANDLE_RE = /\b(?:zalo|skype|telegram|whatsapp|viber)\s*[:\-]?\s*[\w.@:+\-]{3,40}/gi;
/** Intl numbers: +<country>... (1-3 digit code) then 7-12 more digits w/ separators. */
const INTL_PHONE_RE = /\+\d{1,3}(?:[\s.\-]?\d){7,12}\b/g;
/** Vietnamese local: 0xx... 9-11 digits total, spaced/dotted groups allowed. */
const VN_PHONE_RE = /(?<!\d)0(?:[\s.\-]?\d){8,10}\b/g;

export function scrubPii(text: string): string {
  // Email + handles before phones (a handle line may embed a number); intl before VN-local.
  return (text ?? '')
    .replace(EMAIL_RE, '[email-removed]')
    .replace(HANDLE_RE, '[contact-removed]')
    .replace(INTL_PHONE_RE, '[phone-removed]')
    .replace(VN_PHONE_RE, '[phone-removed]');
}

/**
 * Legal-suffix tokens stripped from the END (EN legal forms + country tags) and the
 * VN company-prefix tokens stripped from the FRONT ("công ty (tnhh|cổ phần)").
 * Token-based because punctuation removal splits "Co., Ltd." into bare `co` + `ltd`.
 */
const END_SUFFIX_TOKENS = new Set([
  'co',
  'ltd',
  'jsc',
  'inc',
  'corp',
  'llc',
  'gmbh',
  'pte',
  'company',
  'limited',
  'corporation',
  'incorporated',
  'vietnam',
  'việt',
  'viet',
  'nam',
  'vn',
]);
const FRONT_PREFIX_TOKENS = new Set(['công', 'cong', 'ty', 'tnhh', 'cổ', 'co', 'phần', 'phan']);

/**
 * Company dedup key: lowercase, drop punctuation, strip VN prefixes ("công ty tnhh…")
 * from the front and legal suffixes ("co ltd", "jsc", "vietnam") from the end.
 * "FPT Software Co., Ltd." / "Công ty TNHH FPT Software" → "fpt software".
 * Front-strip only fires when the name STARTS with "công/cong" — "Co Co Coffee" survives.
 */
export function normalizeCompanyName(raw: string): string {
  const tokens = (raw ?? '')
    .toLowerCase()
    .replace(/[(),."']/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  let start = 0;
  if (tokens[0] === 'công' || tokens[0] === 'cong') {
    while (start < tokens.length - 1 && FRONT_PREFIX_TOKENS.has(tokens[start])) start++;
  }
  let end = tokens.length;
  while (end - start > 1 && END_SUFFIX_TOKENS.has(tokens[end - 1])) end--;

  return tokens.slice(start, end).join(' ').trim();
}

/** The 9 pilot role codes (role-rubrics-pilot.json) — keep in sync with RoleRubricService. */
export type RoleCode =
  | 'frontend_developer'
  | 'backend_developer'
  | 'fullstack_developer'
  | 'data_analyst'
  | 'mobile_developer'
  | 'devops_engineer'
  | 'qa_tester'
  | 'ai_ml_engineer'
  | 'ai_app_engineer';

/**
 * Ordered: more specific patterns FIRST. AI/ML + QA + DevOps + Data are checked BEFORE the
 * mobile/frontend/backend stack patterns, because a domain like "ML Engineer (Android on-device)"
 * is primarily an AI/ML role — letting the generic 'android' token win would misclassify it.
 * NOTE: `react(?:js)?` (not `reactjs?` — that meant "reactj" + optional "s", so "React
 * Developer" never matched; review finding).
 */
const ROLE_PATTERNS: Array<[RegExp, RoleCode]> = [
  // AI-APPLICATION roles FIRST — specific tokens (LLM/RAG/GenAI/Applied-AI/AI-Application/Prompt)
  // win over the generic ai_ml pattern below. Deliberately does NOT match bare "AI Engineer" /
  // "ML Engineer", so classic ML / NLP / CV / on-device titles fall through to ai_ml_engineer.
  // Precision: every ambiguous token requires an engineer/developer head — `gen[\s-]?ai\s+(?:...)`
  // (NOT bare `gen ai`) so a "GenAI"/"Gen AI" SKILL mention in a Data-Scientist/QC/Android title
  // does not hijack it to ai_app. The spelled-out `generative ai` head stays loose (real role head).
  [
    /llm\s+(?:engineer|developer)|rag\s+(?:engineer|developer)|gen[\s-]?ai\s+(?:engineer|developer)|generative\s+ai|applied\s+ai\s+(?:engineer|developer)|ai\s+app(?:lication)?\s+(?:engineer|developer)|prompt\s+engineer/i,
    'ai_app_engineer',
  ],
  [
    /\bai\b|machine\s+learning|\bml\b|deep\s+learning|data\s+scientist|\bllm\b|\bnlp\b|computer\s+vision/i,
    'ai_ml_engineer',
  ],
  [
    /data\s+analyst|business\s+analyst.*data|phân\s+tích\s+dữ\s+liệu|data\s+engineer/i,
    'data_analyst',
  ],
  [/devops|\bsre\b|site\s+reliability|platform\s+engineer|cloud\s+engineer/i, 'devops_engineer'],
  [/\bqa\b|\bqc\b|tester|test\s+engineer|quality\s+assurance|kiểm\s*thử/i, 'qa_tester'],
  [/full[\s-]?stack/i, 'fullstack_developer'],
  [/mobile|android|ios|flutter|react\s+native/i, 'mobile_developer'],
  [
    /front[\s-]?end|react(?:js)?\s+developer|vue\s+developer|angular\s+developer/i,
    'frontend_developer',
  ],
  [
    /back[\s-]?end|node(?:js)?\s+developer|java\s+developer|\.net\s+developer|php\s+developer|golang\s+developer|python\s+developer/i,
    'backend_developer',
  ],
  // Generic fallbacks LAST (only fire when nothing specific did):
  [/software\s+engineer|developer|lập\s+trình/i, 'backend_developer'],
];

/** Title → role_code (null when unclassifiable — job stays in pool, excluded from per-role trends). */
export function classifyRole(title: string): RoleCode | null {
  const t = (title ?? '').trim();
  if (t.length === 0) return null;
  for (const [re, code] of ROLE_PATTERNS) {
    if (re.test(t)) return code;
  }
  return null;
}

/**
 * Importance heuristic per text line: skills mentioned on an "advantage" line are
 * NICE_TO_HAVE; everything else defaults REQUIRED (matches MATCH_TUNING multipliers).
 */
const ADVANTAGE_RE =
  /lợi\s*thế|loi\s*the|ưu\s*tiên|uu\s*tien|nice\s*to\s*have|is\s+a\s+plus|plus\s*point|preferred|advantage|bonus|không\s+bắt\s+buộc|optional/i;

export function isAdvantageLine(line: string): boolean {
  return ADVANTAGE_RE.test(line ?? '');
}

/** Stable dedup hash input — see contentHash() in the ingest service. */
export function normalizeForHash(s: string): string {
  return (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

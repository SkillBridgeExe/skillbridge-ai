/**
 * Answer Analyzer — Layer 1 (PR1): `analyzeAnswerSignals`.
 *
 * A PURE, deterministic, language-aware (vi/en) per-answer text analyzer. CODE owns every countable
 * signal — no LLM, no IO, no NestJS DI. The nuanced judgment (relevance, clarity, confidence tone)
 * is Layer 2 (LLM, PR2) and is intentionally NOT computed here.
 *
 * Source spec: docs/superpowers/specs/2026-06-21-interview-answer-analyzer-design.md (§3).
 * Constants (conciseness bands, filler/hedging/stopword lists, STAR cues, repeat threshold) are
 * architect-tunable and live here — never the LLM.
 */

export type Language = 'vi' | 'en';
export type Conciseness = 'too_short' | 'ideal' | 'verbose';

export interface AnswerSignalInput {
  answer: string;
  /** optional — relevance is Layer 2; kept on the input for parity with the L2 contract */
  question?: string;
  /** required/JD terms to check coverage against */
  jd_terms?: string[];
  /** optional jd-term aliases, e.g. { TypeScript: ['TS','ts'] } */
  aliases?: Record<string, string[]>;
  /** selects filler/hedging/stopword/STAR-cue tables */
  language: Language;
}

export interface AnswerSignals {
  word_count: number;
  sentence_count: number;
  conciseness: Conciseness;
  filler: { count: number; terms: string[] };
  hedging: { count: number; terms: string[] };
  repeated_terms: Array<{ term: string; count: number }>;
  jd_term_hits: { hit: string[]; missed: string[]; coverage: number };
  star: { situation: boolean; task: boolean; action: boolean; result: boolean; complete: boolean };
  has_concrete_example: boolean;
  flags: { is_too_short: boolean; no_concrete_example: boolean; rambling_risk: boolean };
}

// ---------------------------------------------------------------------------
// Architect-tunable constants
// ---------------------------------------------------------------------------

/** conciseness word bands: too_short < 20, ideal 20..150, verbose > 150 */
const CONCISENESS_BANDS = { too_short_max: 20, ideal_max: 150 } as const;

/** a content word must occur at least this many times to be a "repeated term" */
const REPEAT_THRESHOLD = 3;

interface LangTable {
  filler: string[];
  hedging: string[];
  stopwords: Set<string>;
  star: {
    situation: string[];
    task: string[];
    action: string[];
    result: string[];
  };
  /** cues that, together with a named tech, signal an action/project (concrete-example heuristic) */
  actionProjectCues: string[];
  /** cues for a quantified result (paired with a number to make a concrete example) */
  quantifiedResultCues: string[];
}

const LANG_TABLES: Record<Language, LangTable> = {
  en: {
    filler: [
      'um',
      'uh',
      'er',
      'like',
      'you know',
      'basically',
      'actually',
      'literally',
      'kind of',
      'sort of',
      'i mean',
      'right',
    ],
    hedging: ['i think', 'maybe', 'probably', 'i guess', 'not sure', 'perhaps', 'might be'],
    stopwords: new Set([
      'a',
      'an',
      'and',
      'the',
      'i',
      'we',
      'you',
      'it',
      'to',
      'of',
      'in',
      'on',
      'for',
      'with',
      'is',
      'was',
      'were',
      'are',
      'be',
      'by',
      'at',
      'as',
      'that',
      'this',
      'then',
      'so',
      'but',
      'or',
      'my',
      'our',
      'they',
      'he',
      'she',
      'them',
      'us',
      'me',
      'had',
      'has',
      'have',
      'did',
      'do',
      'does',
      'from',
      'about',
      'into',
      'over',
      'after',
      'here',
      'there',
      'also',
      'just',
      'again',
      'made',
      'make',
    ]),
    star: {
      situation: ['when', 'we had', 'there was', 'at the time', 'our team was'],
      task: ['i was responsible', 'i was tasked', 'i had to', 'my job was', 'the goal was'],
      action: [
        'i implemented',
        'i built',
        'i used',
        'i added',
        'i created',
        'i designed',
        'i wrote',
      ],
      result: ['result', 'reduced', 'increased', 'improved', 'cut', 'saved', 'as a result'],
    },
    actionProjectCues: [
      'built',
      'implemented',
      'created',
      'designed',
      'developed',
      'shipped',
      'deployed',
      'migrated',
      'refactored',
      'led',
      'architected',
      'project',
    ],
    quantifiedResultCues: [
      'reduced',
      'increased',
      'improved',
      'cut',
      'saved',
      'grew',
      'doubled',
      'tripled',
      'decreased',
    ],
  },
  vi: {
    filler: ['ờ', 'à', 'ừm', 'kiểu như', 'kiểu', 'đại loại', 'nói chung', 'thì là'],
    hedging: ['chắc là', 'hình như', 'không chắc', 'có lẽ', 'đại khái'],
    stopwords: new Set([
      'tôi',
      'mình',
      'chúng',
      'ta',
      'là',
      'và',
      'của',
      'cho',
      'với',
      'một',
      'các',
      'những',
      'này',
      'đó',
      'thì',
      'đã',
      'đang',
      'sẽ',
      'ở',
      'cái',
      'rằng',
      'nên',
      'như',
      'vì',
      'để',
      'có',
      'được',
      'vậy',
      'khi',
      'lúc',
      'do',
      'bị',
      'rất',
      'nhưng',
      'hoặc',
      'nó',
      'họ',
    ]),
    star: {
      situation: ['lúc đó', 'khi đó', 'hồi đó', 'tôi đang', 'hệ thống bị', 'lúc'],
      task: ['tôi phải', 'nhiệm vụ', 'tôi cần', 'mục tiêu', 'tôi được giao'],
      action: ['tôi đã', 'tôi dùng', 'tôi triển khai', 'tôi xây', 'tôi thêm', 'tôi tạo'],
      result: ['kết quả', 'giảm', 'tăng', 'cải thiện', 'tiết kiệm', 'nhờ đó'],
    },
    actionProjectCues: [
      'xây',
      'triển khai',
      'tạo',
      'thiết kế',
      'phát triển',
      'dự án',
      'làm',
      'tối ưu',
      'chuyển',
    ],
    quantifiedResultCues: ['giảm', 'tăng', 'cải thiện', 'tiết kiệm', 'rút ngắn', 'gấp đôi'],
  },
};

/**
 * A small set of commonly-named technologies. Used only by the concrete-example heuristic to decide
 * whether an action/project cue is backed by a NAMED TECH. A named tech ALONE is NOT a concrete
 * example (review-locked) — it must combine with an action/project cue, or the answer must carry a
 * number/percent/quantified-result. This list is language-agnostic.
 */
const NAMED_TECH = [
  'react',
  'vue',
  'angular',
  'node',
  'node.js',
  'nodejs',
  'typescript',
  'javascript',
  'python',
  'java',
  'go',
  'rust',
  'docker',
  'kubernetes',
  'k8s',
  'redis',
  'postgres',
  'postgresql',
  'mysql',
  'mongodb',
  'kafka',
  'graphql',
  'rest',
  'aws',
  'gcp',
  'azure',
  'terraform',
  'nginx',
  'nestjs',
  'express',
  'spring',
  'django',
  'flask',
  'tensorflow',
  'pytorch',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** lowercase + strip punctuation (keep letters/digits/%/whitespace and unicode word chars). */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}%\s.]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** escape a string for safe use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Count whole-phrase, case-insensitive occurrences of `phrase` in `text`, using unicode-aware word
 * boundaries (so "um" does not match "umbrella", but Vietnamese diacritics still match). Returns the
 * number of occurrences.
 */
function countPhrase(text: string, phrase: string): number {
  const p = escapeRegExp(phrase.toLowerCase());
  // (^|non-word-char) phrase (non-word-char|$) — \p{L}/\p{N} as the "word char" class for unicode.
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${p}(?![\\p{L}\\p{N}])`, 'giu');
  const matches = text.toLowerCase().match(re);
  return matches ? matches.length : 0;
}

/** does `text` contain `phrase` as a whole word/phrase (count >= 1). */
function hasPhrase(text: string, phrase: string): boolean {
  return countPhrase(text, phrase) > 0;
}

function classifyConciseness(words: number): Conciseness {
  if (words < CONCISENESS_BANDS.too_short_max) return 'too_short';
  if (words <= CONCISENESS_BANDS.ideal_max) return 'ideal';
  return 'verbose';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function analyzeAnswerSignals(input: AnswerSignalInput): AnswerSignals {
  const { answer, language } = input;
  const table = LANG_TABLES[language];
  const lower = answer.toLowerCase();
  const norm = normalize(answer);

  // --- counts ---
  const words = answer.trim().length === 0 ? [] : answer.trim().split(/\s+/);
  const word_count = words.length;
  const sentence_count =
    answer.trim().length === 0
      ? 0
      : answer
          .split(/[.!?…]+|\n+/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0).length;

  const conciseness = classifyConciseness(word_count);

  // --- filler / hedging (word-boundary, case-insensitive, per-language) ---
  const filler = collectMatches(lower, table.filler);
  const hedging = collectMatches(lower, table.hedging);

  // --- repeated_terms (DESCRIPTIVE only — never a negative flag) ---
  const repeated_terms = computeRepeatedTerms(norm, table.stopwords);

  // --- jd_term_hits (normalized exact-phrase/substring + optional aliases) ---
  const jd_term_hits = computeJdHits(norm, input.jd_terms ?? [], input.aliases ?? {});

  // --- STAR section markers (DESCRIPTIVE; no penalty flag derived here) ---
  const star = computeStar(norm, table.star);

  // --- has_concrete_example (review-locked rule) ---
  const has_concrete_example = computeConcreteExample(answer, norm, table);

  // --- flags (ONLY from conciseness + concrete + jd coverage) ---
  const is_too_short = conciseness === 'too_short';
  const no_concrete_example = !has_concrete_example;
  const rambling_risk =
    conciseness === 'verbose' && !has_concrete_example && jd_term_hits.coverage < 0.5;

  return {
    word_count,
    sentence_count,
    conciseness,
    filler,
    hedging,
    repeated_terms,
    jd_term_hits,
    star,
    has_concrete_example,
    flags: { is_too_short, no_concrete_example, rambling_risk },
  };
}

/** collect matched terms (deduped, in table order) + total occurrence count. */
function collectMatches(lower: string, terms: string[]): { count: number; terms: string[] } {
  const matched: string[] = [];
  let count = 0;
  for (const term of terms) {
    const n = countPhrase(lower, term);
    if (n > 0) {
      matched.push(term);
      count += n;
    }
  }
  return { count, terms: matched };
}

function computeRepeatedTerms(
  norm: string,
  stopwords: Set<string>,
): Array<{ term: string; count: number }> {
  const tokens = norm.split(' ').filter((t) => t.length > 0 && !stopwords.has(t));
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, c]) => c >= REPEAT_THRESHOLD)
    .map(([term, count]) => ({ term, count }))
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term));
}

function computeJdHits(
  norm: string,
  jd_terms: string[],
  aliases: Record<string, string[]>,
): { hit: string[]; missed: string[]; coverage: number } {
  const hit: string[] = [];
  const missed: string[] = [];
  for (const term of jd_terms) {
    // normalize the candidate phrases (the term itself + any aliases) and substring-match against norm.
    // LIMITATION (PR1): matching is normalized exact-phrase / substring only. Without an alias entry,
    // "TS" will NOT match "TypeScript" (they are different normalized strings). The optional aliases
    // map closes this gap explicitly per JD term.
    const candidates = [term, ...(aliases[term] ?? [])].map((c) => normalize(c)).filter(Boolean);
    const matched = candidates.some((c) => norm.includes(c));
    if (matched) hit.push(term);
    else missed.push(term);
  }
  const coverage = jd_terms.length === 0 ? 1 : hit.length / jd_terms.length;
  return { hit, missed, coverage };
}

function computeStar(norm: string, cues: LangTable['star']): AnswerSignals['star'] {
  const has = (list: string[]): boolean => list.some((cue) => norm.includes(normalize(cue)));
  const situation = has(cues.situation);
  const task = has(cues.task);
  const action = has(cues.action);
  const result = has(cues.result);
  return { situation, task, action, result, complete: situation && task && action && result };
}

/**
 * has_concrete_example (review-locked): true if the answer has
 *   (a) digits or a percent, OR
 *   (b) a quantified-result cue PAIRED WITH a number, OR
 *   (c) an action/project cue AND a named tech.
 * A NAMED TECH ALONE is NOT enough ("Tôi dùng React" / "I used Docker" → false).
 */
function computeConcreteExample(answer: string, norm: string, table: LangTable): boolean {
  const hasDigitOrPercent = /[0-9]|%/.test(answer);
  if (hasDigitOrPercent) return true;

  // (b) is subsumed by (a): a quantified result is only "concrete" when accompanied by a number,
  // and any number already triggers (a). Kept explicit for documentation; no extra branch needed.

  // (c) action/project cue AND a named tech.
  const hasActionCue = table.actionProjectCues.some((c) => hasPhrase(norm, c));
  const hasNamedTech = NAMED_TECH.some((t) => hasPhrase(norm, t));
  return hasActionCue && hasNamedTech;
}

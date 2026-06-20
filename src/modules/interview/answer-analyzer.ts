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
  /** cues that, together with a tech signal, signal an action/project (concrete-example heuristic) */
  actionProjectCues: string[];
  /**
   * magnitude/quantified-result cues — words that encode a concrete change WITHOUT needing a digit
   * ("doubled", "reduced by half", "giảm"). Their presence ALONE satisfies concreteness (rule b).
   */
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
      'quadrupled',
      'halved',
      'decreased',
      'boosted',
      'slashed',
      'by half',
    ],
  },
  vi: {
    // Bare common headwords are NEVER filler entries. `kiểu` is the headword for "type/kind/style"
    // (kiểu dữ liệu = data type, kiểu kiến trúc = architecture style) so it must NOT be listed alone
    // — only the multi-word disfluency `kiểu như` (and similar phrases) counts.
    filler: [
      'ờ',
      'à',
      'ừm',
      'kiểu như',
      'kiểu kiểu',
      'đại loại là',
      'đại loại',
      'nói chung là',
      'nói chung',
      'thì là',
    ],
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
      // Build/ship verbs ONLY. Deliberately EXCLUDES generic "dùng" (use) and "làm" (do/make):
      // "Tôi dùng React" / "Tôi làm giao diện" must NOT count as a concrete example (review rule —
      // a named tech alone is not enough; it needs a building/shipping action or a number). This
      // mirrors EN, where "used" is likewise absent from actionProjectCues.
      'xây',
      'triển khai',
      'tạo',
      'thiết kế',
      'phát triển',
      'dự án',
      'tối ưu',
      'chuyển',
    ],
    quantifiedResultCues: [
      'giảm',
      'tăng',
      'cải thiện',
      'tiết kiệm',
      'rút ngắn',
      'gấp đôi',
      'gấp ba',
    ],
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

/**
 * Concrete-example number heuristics (rule a) — a number is only EVIDENCE when it sits next to a
 * unit/metric, never just because a digit appears. A bare year, an age/tenure ("5 years"), a
 * team-size ("team of 4"), a version ("Python 3"), or a phone number must NOT alone satisfy
 * concreteness. Language-agnostic. The quantified-result words (rule b) live in each language's
 * LangTable.quantifiedResultCues so they stay architect-tunable.
 */
// a digit with a directly-attached unit suffix: 30%, 200ms, 2x, 10k, 1.5gb …
const UNIT_SUFFIX_RE = /\b\d+(?:\.\d+)?\s?(?:%|ms|s|x|k|m|gb|mb|kb|tb|fps|qps|rps|kloc)\b/u;
// metric / deliverable nouns that make an ADJACENT number meaningful.
const METRIC_NOUN =
  '(?:users?|customers?|requests?|reqs?|latency|throughput|errors?|downtime|uptime|revenue|' +
  'conversions?|engagement|coverage|tests?|bugs?|defects?|deploys?|deployments?|releases?|' +
  'features?|components?|services?|endpoints?|apis?|microservices?|pages?|screens?|tables?|' +
  'queries|jobs?|pipelines?|models?|seconds?|minutes?|hours?|days?|weeks?|months?|millis|' +
  'milliseconds?|percent|p\\d{2,3})';
// up to ~3 filler tokens may sit between the number and the metric noun ("by 2 active users").
const NUM_NOUN_WINDOW = '(?:[\\p{L}\\p{N}.]+\\s+){0,3}';
const NUM_THEN_NOUN_RE = new RegExp(
  `\\b\\d+(?:\\.\\d+)?\\s+${NUM_NOUN_WINDOW}${METRIC_NOUN}\\b`,
  'u',
);
const NOUN_THEN_NUM_RE = new RegExp(
  `\\b${METRIC_NOUN}\\s+${NUM_NOUN_WINDOW}\\d+(?:\\.\\d+)?\\b`,
  'u',
);
/** common capitalized words that are NOT proper-noun tech signals. */
const COMMON_CAPS = new Set([
  'I',
  'A',
  'The',
  'We',
  'My',
  'It',
  'They',
  'He',
  'She',
  'You',
  'And',
  'But',
  'So',
  'As',
  'In',
  'On',
  'At',
  'For',
  'To',
  'Of',
  'Then',
  'When',
  'This',
  'That',
]);

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
  const has_concrete_example = computeConcreteExample(answer, norm, table, jd_term_hits.hit);

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

/** whole-word/phrase match spans (start/end index into `text`) for `phrase`, case-insensitive. */
function matchSpans(text: string, phrase: string): Array<{ start: number; end: number }> {
  const p = escapeRegExp(phrase.toLowerCase());
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${p}(?![\\p{L}\\p{N}])`, 'giu');
  const spans: Array<{ start: number; end: number }> = [];
  const lower = text.toLowerCase();
  let m: RegExpExecArray | null;
  while ((m = re.exec(lower)) !== null) {
    spans.push({ start: m.index, end: m.index + m[0].length });
    if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-width
  }
  return spans;
}

/**
 * collect matched terms (deduped, in table order) + total occurrence count.
 * Longer phrases are counted FIRST and their spans are claimed, so a shorter sub-phrase contained
 * inside an already-counted longer one is not double-counted (one genuine "kiểu như" no longer
 * counts as both "kiểu như" and "kiểu"; "đại loại là" no longer also counts "đại loại").
 */
function collectMatches(lower: string, terms: string[]): { count: number; terms: string[] } {
  const order = new Map(terms.map((t, i) => [t, i]));
  const byLengthDesc = [...terms].sort((a, b) => b.length - a.length || a.localeCompare(b));
  const claimed: Array<{ start: number; end: number }> = [];
  const overlaps = (s: { start: number; end: number }): boolean =>
    claimed.some((c) => s.start < c.end && c.start < s.end);

  const hits: Array<{ term: string; count: number }> = [];
  for (const term of byLengthDesc) {
    let count = 0;
    for (const span of matchSpans(lower, term)) {
      if (overlaps(span)) continue;
      claimed.push(span);
      count += 1;
    }
    if (count > 0) hits.push({ term, count });
  }

  const total = hits.reduce((sum, h) => sum + h.count, 0);
  const matchedTerms = hits
    .map((h) => h.term)
    .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  return { count: total, terms: matchedTerms };
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

/** whole-word/phrase match of an already-normalized candidate against already-normalized text. */
function normContainsWord(norm: string, candidate: string): boolean {
  return countPhrase(norm, candidate) > 0;
}

function computeJdHits(
  norm: string,
  jd_terms: string[],
  aliases: Record<string, string[]>,
): { hit: string[]; missed: string[]; coverage: number } {
  const hit: string[] = [];
  const missed: string[] = [];
  for (const term of jd_terms) {
    // normalize the candidate phrases (the term itself + any aliases) and WHOLE-WORD match against
    // norm. Whole-word (not bare substring) so "Java" does NOT match inside "JavaScript" and "Go"
    // does NOT match inside "golang" — see countPhrase's unicode word boundaries.
    // LIMITATION (PR1): without an alias entry, "TS" still won't match "TypeScript" (different
    // normalized strings). The optional aliases map closes that gap explicitly per JD term.
    const candidates = [term, ...(aliases[term] ?? [])].map((c) => normalize(c)).filter(Boolean);
    const matched = candidates.some((c) => normContainsWord(norm, c));
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
 * has_concrete_example (review-locked, hardened): true if the answer has
 *   (a) a number IN A MEANINGFUL CONTEXT — a unit suffix (30%, 200ms) or a number adjacent to a
 *       metric/deliverable noun (10000 users, 3 features). A BARE number alone (year, age/tenure,
 *       team size, version, phone) does NOT qualify, OR
 *   (b) a quantified-result cue ("doubled", "reduced … by half", "giảm") — magnitude WITHOUT a
 *       digit is still concrete, OR
 *   (c) an action/project cue AND a tech signal — a known NAMED_TECH, a jd_term hit, OR a
 *       capitalized proper-noun-looking token (so off-allowlist stacks like Svelte/Elixir/Cassandra
 *       are not false-negatives; NAMED_TECH is a small hardcoded list and always lags the ecosystem).
 * A TECH NAME ALONE is still NOT enough ("Tôi dùng React" / "I used Docker" → false): rule (c) needs
 * a building/shipping action cue, and "dùng"/"used" are deliberately absent from actionProjectCues.
 */
function computeConcreteExample(
  answer: string,
  norm: string,
  table: LangTable,
  jdHits: string[],
): boolean {
  // (a) number in a meaningful context (unit suffix OR adjacent metric/deliverable noun).
  if (UNIT_SUFFIX_RE.test(norm) || NUM_THEN_NOUN_RE.test(norm) || NOUN_THEN_NUM_RE.test(norm)) {
    return true;
  }

  // (b) a quantified-result cue (per-language, architect-tunable) encodes magnitude even without a
  // digit ("doubled the users", "reduced by half", "giảm thời gian").
  if (table.quantifiedResultCues.some((c) => hasPhrase(norm, c))) return true;

  // (c) action/project cue AND a tech signal.
  const hasActionCue = table.actionProjectCues.some((c) => hasPhrase(norm, c));
  if (!hasActionCue) return false;
  const hasNamedTech = NAMED_TECH.some((t) => hasPhrase(norm, t));
  const hasJdHit = jdHits.length > 0;
  return hasNamedTech || hasJdHit || hasProperNounToken(answer);
}

/**
 * Does the original answer carry a capitalized, proper-noun-looking token NOT at sentence start?
 * Used as a tech signal for rule (c) so off-allowlist names (Svelte, Elixir, Cassandra) qualify when
 * paired with an action cue. Sentence-initial caps and common capitalized words (I, The, We …) are
 * ignored to avoid false positives.
 */
function hasProperNounToken(answer: string): boolean {
  const sentences = answer.split(/[.!?…\n]+/);
  for (const s of sentences) {
    const toks = s.trim().split(/\s+/).filter(Boolean);
    for (let i = 1; i < toks.length; i++) {
      const raw = toks[i].replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      if (raw.length < 2 || COMMON_CAPS.has(raw)) continue;
      const first = raw[0];
      // first char must be an upper-case LETTER (has a distinct lower-case form).
      if (first !== first.toUpperCase() || first === first.toLowerCase()) continue;
      if (/^[A-Z][A-Za-z0-9.+#-]*$/.test(raw)) return true;
    }
  }
  return false;
}

/**
 * CV Builder Assistant — Turn-2 grounding (PURE, no IO, no LLM).
 *
 * Two anti-fabrication chokepoints (spec §3/§7, Codex fixes #3/#4):
 *   1. `groundCvAssistantAnswers` — turns the user's chip+detail answers into the ONLY facts the rewrite
 *      model may use. A `tech` answer without a concrete named tech → `needs_detail` → the assistant must
 *      RE-ASK, never rewrite on a bare category.
 *   2. `groundCvRewrite` — validates the model's rewrite: every number / tech / proper-noun entity in
 *      `after` must come from the user's facts OR the original bullet; the model's declared `used_facts`
 *      must be a subset of the allowed facts. Any violation → REJECT (return a follow-up, never a patch).
 */
import { AssistantGap, CvAnswer, Language } from './cv-assistant';
import { sanitizePromptText } from '../../common/services/prompt-input-sanitizer';

export interface GroundedAnswers {
  /** the ONLY fact phrases the rewrite model may use (action verb · named tech · result phrase · number). */
  facts: string[];
  /** gaps whose concrete detail is still missing → RE-ASK, do not rewrite. */
  needs_detail: AssistantGap[];
}

/** what the rewrite LLM must return (schema-enforced). */
export interface RewriteModelOutput {
  after: string;
  /** the facts the model claims it used — must be a subset of the allowed facts. */
  used_facts: string[];
}

export interface FieldPatch {
  target: string;
  before: string;
  after: string;
  why: string;
}

export type RewriteVerdict =
  | { ok: true; field_patch: FieldPatch }
  | { ok: false; reason: 'NEEDS_DETAIL' | 'UNGROUNDED'; gap?: AssistantGap; detail: string };

// ---------------------------------------------------------------------------
// 1) ground the user's answers → allowed facts
// ---------------------------------------------------------------------------

const ACTION_FACT: Record<Language, Record<string, string>> = {
  en: { built: 'built', designed: 'designed', led: 'led', fixed: 'improved', other: '' },
  vi: { built: 'xây', designed: 'thiết kế', led: 'dẫn dắt', fixed: 'cải thiện', other: '' },
};
const RESULT_FACT: Record<Language, Record<string, string>> = {
  en: {
    faster: 'faster',
    more_users: 'more users',
    fewer_errors: 'fewer errors',
    process: 'better process',
    none: '',
  },
  vi: {
    faster: 'nhanh hơn',
    more_users: 'nhiều người dùng hơn',
    fewer_errors: 'ít lỗi hơn',
    process: 'quy trình tốt hơn',
    none: '',
  },
};
const ROLE_FACT: Record<Language, Record<string, string>> = {
  en: {
    frontend: 'Frontend Developer',
    backend: 'Backend Developer',
    fullstack: 'Fullstack Developer',
    data: 'Data Analyst',
    other: '',
  },
  vi: {
    frontend: 'Lập trình viên Frontend',
    backend: 'Lập trình viên Backend',
    fullstack: 'Lập trình viên Fullstack',
    data: 'Chuyên viên phân tích dữ liệu',
    other: '',
  },
};
const EVIDENCE_FACT: Record<Language, Record<string, string>> = {
  en: { fresher: '', '1_2y': '1-2 years', '3_5y': '3-5 years', '5y_plus': '5+ years', none: '' },
  vi: { fresher: '', '1_2y': '1-2 năm', '3_5y': '3-5 năm', '5y_plus': '5+ năm', none: '' },
};

/** split a free-text "React, Node and Redis" into individual fact tokens. */
function pushList(detail: string, facts: string[]): void {
  for (const t of detail
    .split(/[,/;]| and | và /i)
    .map((s) => s.trim())
    .filter(Boolean)) {
    facts.push(t);
  }
}

export function groundCvAssistantAnswers(answers: CvAnswer[], language: Language): GroundedAnswers {
  const facts: string[] = [];
  const needs_detail: AssistantGap[] = [];
  for (const a of answers) {
    switch (a.gap) {
      case 'action': {
        const phrase =
          a.option_id === 'other' ? (a.detail ?? '') : (ACTION_FACT[language][a.option_id] ?? '');
        if (phrase.trim()) facts.push(phrase.trim());
        break;
      }
      case 'tech':
      case 'strength': {
        // a bare category ('Backend') is NOT enough — require concrete named tech/skills (Codex fix #3).
        if (!a.detail || a.detail.trim().length < 2) {
          needs_detail.push(a.gap);
          break;
        }
        pushList(a.detail, facts);
        break;
      }
      case 'result': {
        // the chip gives a QUALITATIVE result (no number); an optional detail may add a number.
        const phrase = RESULT_FACT[language][a.option_id] ?? '';
        if (phrase.trim()) facts.push(phrase.trim());
        if (a.detail && a.detail.trim()) facts.push(a.detail.trim());
        break;
      }
      case 'role': {
        const phrase =
          a.option_id === 'other' ? (a.detail ?? '') : (ROLE_FACT[language][a.option_id] ?? '');
        if (phrase.trim()) facts.push(phrase.trim());
        else if (a.detail && a.detail.trim()) facts.push(a.detail.trim());
        break;
      }
      case 'evidence': {
        const phrase = EVIDENCE_FACT[language][a.option_id] ?? '';
        if (phrase.trim()) facts.push(phrase.trim());
        if (a.detail && a.detail.trim()) facts.push(a.detail.trim());
        break;
      }
      case 'user_clarify': {
        // "ask more" free text — the user's own clarification is a grounded fact verbatim
        // (its numbers/tech become allowed evidence for the rewrite gate).
        if (a.detail && a.detail.trim()) facts.push(a.detail.trim());
        break;
      }
    }
  }
  return { facts, needs_detail };
}

// ---------------------------------------------------------------------------
// 2) validate the model rewrite against the allowed facts (anti-fabrication)
// ---------------------------------------------------------------------------

/**
 * A number, an optional range, and an optional ADJACENT unit, captured as ONE token. This makes the
 * gate unit-aware ("30%" ≠ "30ms") and range-atomic ("3-5 years" does not authorize the bare digits
 * 3 or 5 as standalone metrics) — both real anti-fabrication holes a bare-digit set would miss.
 *
 * The range separator accepts en/em-dash ("1–2" is one range token, not two bare digits), and a
 * letter unit only counts when NOT followed by a letter/digit — otherwise "3 mảnh" tokenized as
 * "3 m" (metres) and "1 kết quả" as "1 k" (thousand), which broke the benign-noun adjacency check
 * downstream. The lookahead sits INSIDE the optional unit group on purpose: if it sat after the
 * whole token, a failed unit would fail the entire match and the digits would escape the net.
 */
export const NUMBER_TOKEN_RE =
  /\d+(?:\.\d+)?(?:\s*[-–—]\s*\d+(?:\.\d+)?)?(?:\s?(?:%|ms|s|x|k|m|gb|mb|users?|requests?|reqs?|hours?|days?|weeks?|months?|years?|năm)(?![\p{L}\p{N}]))?/giu;

/** ONE normalization for number tokens on EVERY licensing side (spaces stripped, dash variants
 *  folded to ASCII "-", lowercased) — if the sides disagree on form, "1–2" can never match "1-2". */
export function normalizeNumberToken(raw: string): string {
  return raw.replace(/\s+/g, '').replace(/[–—]/g, '-').toLowerCase();
}

/** normalized number+unit tokens for exact, unit-aware comparison. */
export function numberTokens(text: string): string[] {
  return (text.match(NUMBER_TOKEN_RE) ?? []).map(normalizeNumberToken).filter((t) => /\d/.test(t));
}

/**
 * KNOWN specific technologies/products. The anti-fabrication gate rejects a SPECIFIC tech the user did
 * not give (e.g. the model adds "Kafka"). It deliberately does NOT reject generic descriptors (API,
 * REST, UI, service…) — flagging every capitalized word over-rejects plausible prose and spams re-asks.
 * Numbers are still exact-checked, the prompt forbids fabrication, and the user confirms before Apply.
 */
export const NAMED_TECH = [
  'react',
  'vue',
  'angular',
  'svelte',
  'next.js',
  'nuxt',
  'node',
  'node.js',
  'nodejs',
  'express',
  'nestjs',
  'spring',
  'spring boot',
  'django',
  'flask',
  'rails',
  'laravel',
  '.net',
  'dotnet',
  'typescript',
  'javascript',
  'python',
  'java',
  'golang',
  'rust',
  'kotlin',
  'swift',
  'php',
  'redis',
  'postgres',
  'postgresql',
  'mysql',
  'mongodb',
  'sqlite',
  'elasticsearch',
  'cassandra',
  'kafka',
  'rabbitmq',
  'graphql',
  'grpc',
  'docker',
  'kubernetes',
  'k8s',
  'terraform',
  'nginx',
  'aws',
  'gcp',
  'azure',
  'firebase',
  'supabase',
  'vercel',
  'stripe',
  'tensorflow',
  'pytorch',
  'flutter',
  // AI / ML / vector-DB / data products — the high-value fabrication risk on an AI career platform.
  'langchain',
  'llamaindex',
  'pinecone',
  'chroma',
  'weaviate',
  'qdrant',
  'milvus',
  'ollama',
  'huggingface',
  'transformers',
  'mistral',
  'llama',
  'gemini',
  'openai',
  'anthropic',
  'gpt',
  'claude',
  'bert',
  'spark',
  'hadoop',
  'airflow',
  'snowflake',
  'databricks',
  'tableau',
  // CI / SCM tooling commonly fabricated into pipelines.
  'jenkins',
  'github',
  'gitlab',
];

/** whole-word, case-insensitive, unicode-aware presence of `word` in `text` (so 'node' ≠ 'nodemon'). */
export function hasWord(text: string, word: string): boolean {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

/** URLs / bare domains — a rewrite may not add a link the user never gave (P3-5 case 1). */
const URL_RE = /(?:https?:\/\/|www\.)\S+|\b[\w-]+\.(?:com|org|net|io|dev|ai|app|vn|co)\b/giu;
export function urlTokens(text: string): string[] {
  return (text.match(URL_RE) ?? []).map((u) => u.toLowerCase());
}

/** credential claims — fabricating a certificate is a hard reject (P3-5 case 1). */
export const CREDENTIAL_WORDS = [
  'certified',
  'certification',
  'certificate',
  'chứng chỉ',
  'ielts',
  'toeic',
];

/**
 * NEW multi-word proper-noun phrases ("Nova Dynamics", "Google Cloud") — the deterministic
 * employer/org/product fabrication net. A run of ≥2 capitalized tokens counts only when at least
 * one token is TitleCase (Upper+lower), so all-caps generic pairs ("REST API") stay allowed, and a
 * run never starts at a sentence-initial token (normal sentence case can't false-positive).
 * ponytail: a bare single-word org ("Google") still slips unless it's in NAMED_TECH — add a real
 * org gazetteer only if this proves too loose in the eval corpus.
 */
export function properNounPhrases(text: string): string[] {
  const toks = text.split(/\s+/);
  // trailing dots are stripped so a sentence-final name compares clean ("Developer." → "Developer");
  // internal dots survive ("Node.js"). Stripping only widens what a licensed corpus can match — a
  // fabricated "Nova Dynamics." still fails the corpus lookup with or without its dot.
  const clean = (w: string) =>
    w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}.+#&-]+$/gu, '').replace(/\.+$/, '');
  const isCap = (w: string) => w.length >= 2 && /^[\p{Lu}][\p{L}\p{N}.+#&-]*$/u.test(w);
  const isTitle = (w: string) => /^[\p{Lu}]\p{Ll}/u.test(w);
  // a run never CONTINUES across trailing punctuation — "React, Firebase" is a list of two single
  // tokens and "Node.js. Đã" spans a sentence boundary; joining them minted phrases nobody wrote,
  // which the corpus lookup then "caught" (measured false kills). Each side of the break is a lone
  // capitalized token, which this net never matched anyway — so no new phrase can slip through.
  // NOTE: this set stays OFF the run-START guard below — a capitalized word after a comma is not
  // sentence-initial, and skipping it would let a fabricated org hide behind a comma.
  const breaksRun = (raw: string) => /[.!?:;,]$/.test(raw);
  const phrases: string[] = [];
  let i = 1; // token 0 is sentence-initial by definition
  while (i < toks.length) {
    const sentenceInitial = /[.!?:]$/.test(toks[i - 1]);
    const w = clean(toks[i]);
    if (!sentenceInitial && isCap(w)) {
      const run = [w];
      let j = i + 1;
      while (j < toks.length && !breaksRun(toks[j - 1]) && isCap(clean(toks[j]))) {
        run.push(clean(toks[j]));
        j += 1;
      }
      if (run.length >= 2 && run.some(isTitle)) phrases.push(run.join(' '));
      i = j;
    } else {
      i += 1;
    }
  }
  return phrases;
}

/**
 * (g) textual temporal expressions — the non-numeric date fabrication net (W112).
 * The number net (b) already catches digit dates ("2023", "03/2024"); this catches
 * worded time claims: month names, qualified seasons, and relative periods
 * ("in January", "last summer", "two years ago", "tháng Ba", "năm ngoái").
 * Ambiguous EN month words (may/march/august — also modal/verb/adjective) count
 * only after a temporal preposition, so "this may improve" stays allowed.
 * ponytail: full month names only — add abbreviations (Jan/Sept) if the eval
 * corpus ever shows them slipping through.
 */
const MONTHS_EN = [
  'january',
  'february',
  'april',
  'june',
  'july',
  'september',
  'october',
  'november',
  'december',
];
const MONTHS_EN_AMBIGUOUS_RE =
  /\b(?:in|by|since|from|until|till|during|between|before|after|early|mid|late)[\s-]+(may|march|august)\b/giu;
const SEASONS_EN_RE =
  /\b(?:last|next|this|in|during|early|mid|late)\s+(?:the\s+)?(spring|summer|autumn|winter|fall)\b/giu;
const RELATIVE_EN_RE =
  /\b(?:last|next)\s+(?:year|month|week|quarter)\b|\b\S+\s+(?:years?|months?|weeks?)\s+ago\b/giu;
const TEMPORAL_VI = [
  'tháng giêng',
  'tháng chạp',
  'tháng một',
  'tháng hai',
  'tháng ba',
  'tháng tư',
  'tháng bốn',
  'tháng năm',
  'tháng sáu',
  'tháng bảy',
  'tháng tám',
  'tháng chín',
  'tháng mười',
  'mùa xuân',
  'mùa hạ',
  'mùa hè',
  'mùa thu',
  'mùa đông',
  'năm ngoái',
  'năm trước',
  'năm sau',
  'năm tới',
  'tháng trước',
  'tháng sau',
  'tháng tới',
  'tuần trước',
  'tuần sau',
  'quý trước',
  'quý sau',
];

export function temporalTokens(text: string): string[] {
  const found: string[] = [];
  for (const month of MONTHS_EN) if (hasWord(text, month)) found.push(month);
  for (const m of text.matchAll(MONTHS_EN_AMBIGUOUS_RE)) found.push(m[1].toLowerCase());
  for (const m of text.matchAll(SEASONS_EN_RE)) found.push(m[1].toLowerCase());
  for (const m of text.matchAll(RELATIVE_EN_RE)) found.push(m[0].toLowerCase());
  const lower = text.toLowerCase();
  // "tháng mười một/hai" also contain "tháng mười" — substring check keeps both grounded consistently.
  for (const phrase of TEMPORAL_VI) if (lower.includes(phrase)) found.push(phrase);
  return found;
}

export function groundCvRewrite(
  before: string,
  model: RewriteModelOutput,
  grounded: GroundedAnswers,
  opts: { target: string; why: string },
): RewriteVerdict {
  if (grounded.needs_detail.length > 0) {
    return {
      ok: false,
      reason: 'NEEDS_DETAIL',
      gap: grounded.needs_detail[0],
      detail: 'missing concrete detail',
    };
  }
  // allowed evidence = the user's facts + the words already in the original bullet.
  const source = `${grounded.facts.join(' ')} ${before}`;
  // numbers are matched as whole UNIT-aware tokens: "30%" ≠ "30ms", and "3-5 years" ≠ "5 years".
  const allowedNumbers = new Set(numberTokens(source));

  // (a) every declared used_fact must be one of the allowed facts. The model never sees the
  //     ORIGINAL facts — PromptsService.render sanitizes vars (M6) — so a fact carrying a
  //     redacted span can only be echoed back in its sanitized form; accept that form too, or
  //     grounding deterministically rejects legitimate facts (post-merge review finding).
  const allowedFacts = new Set(
    grounded.facts.flatMap((f) => [f.toLowerCase(), sanitizePromptText(f).text.toLowerCase()]),
  );
  for (const uf of model.used_facts) {
    if (!allowedFacts.has(uf.toLowerCase())) {
      return { ok: false, reason: 'UNGROUNDED', detail: `used_fact not in allowed facts: ${uf}` };
    }
  }
  // (b) every number+unit in `after` must be one the user actually gave (exact token, unit-aware).
  for (const num of numberTokens(model.after)) {
    if (!allowedNumbers.has(num)) {
      return { ok: false, reason: 'UNGROUNDED', detail: `fabricated number: ${num}` };
    }
  }
  // (c) no fabricated SPECIFIC tech: a known tech name appears in `after` but the user never gave it.
  //     Generic descriptors (API/REST/UI/service) are intentionally allowed (avoids re-ask spam).
  for (const tech of NAMED_TECH) {
    if (hasWord(model.after, tech) && !hasWord(source, tech)) {
      return { ok: false, reason: 'UNGROUNDED', detail: `fabricated tech: ${tech}` };
    }
  }
  // (d) no fabricated URL/domain — a link is evidence; the user must have given it.
  const sourceLower = source.toLowerCase();
  for (const url of urlTokens(model.after)) {
    if (!sourceLower.includes(url)) {
      return { ok: false, reason: 'UNGROUNDED', detail: `fabricated url: ${url}` };
    }
  }
  // (e) no fabricated credential claim (certificates are a hard fabrication risk on a CV).
  for (const word of CREDENTIAL_WORDS) {
    if (hasWord(model.after, word) && !hasWord(source, word)) {
      return { ok: false, reason: 'UNGROUNDED', detail: `fabricated credential: ${word}` };
    }
  }
  // (f) no NEW multi-word proper-noun phrase — the employer/org/product fabrication net.
  for (const phrase of properNounPhrases(model.after)) {
    if (!sourceLower.includes(phrase.toLowerCase())) {
      return { ok: false, reason: 'UNGROUNDED', detail: `fabricated entity: ${phrase}` };
    }
  }
  // (g) no fabricated textual date/period — worded months, seasons, relative time (W112).
  for (const tk of temporalTokens(model.after)) {
    const present = tk.includes(' ') ? sourceLower.includes(tk) : hasWord(source, tk);
    if (!present) {
      return { ok: false, reason: 'UNGROUNDED', detail: `fabricated date/time: ${tk}` };
    }
  }
  return {
    ok: true,
    field_patch: { target: opts.target, before, after: model.after, why: opts.why },
  };
}

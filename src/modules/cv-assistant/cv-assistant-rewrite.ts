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
import { BulletGap, CvAnswer, Language } from './cv-assistant';

export interface GroundedAnswers {
  /** the ONLY fact phrases the rewrite model may use (action verb · named tech · result phrase · number). */
  facts: string[];
  /** gaps whose concrete detail is still missing → RE-ASK, do not rewrite. */
  needs_detail: BulletGap[];
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
  | { ok: false; reason: 'NEEDS_DETAIL' | 'UNGROUNDED'; gap?: BulletGap; detail: string };

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

export function groundCvAssistantAnswers(answers: CvAnswer[], language: Language): GroundedAnswers {
  const facts: string[] = [];
  const needs_detail: BulletGap[] = [];
  for (const a of answers) {
    if (a.gap === 'action') {
      const phrase =
        a.option_id === 'other' ? (a.detail ?? '') : (ACTION_FACT[language][a.option_id] ?? '');
      if (phrase.trim()) facts.push(phrase.trim());
    } else if (a.gap === 'tech') {
      // a bare category ('Backend') is NOT enough — require a concrete named tech (Codex fix #3).
      if (!a.detail || a.detail.trim().length < 2) {
        needs_detail.push('tech');
        continue;
      }
      for (const t of a.detail
        .split(/[,/;]| and | và /i)
        .map((s) => s.trim())
        .filter(Boolean)) {
        facts.push(t);
      }
    } else {
      // result: the chip gives a QUALITATIVE result (no number); an optional detail may add a number.
      const phrase = RESULT_FACT[language][a.option_id] ?? '';
      if (phrase.trim()) facts.push(phrase.trim());
      if (a.detail && a.detail.trim()) facts.push(a.detail.trim());
    }
  }
  return { facts, needs_detail };
}

// ---------------------------------------------------------------------------
// 2) validate the model rewrite against the allowed facts (anti-fabrication)
// ---------------------------------------------------------------------------

const NUMBER_RE = /\d+(?:\.\d+)?/g;
const COMMON_CAPS = new Set([
  'I',
  'A',
  'The',
  'We',
  'My',
  'It',
  'In',
  'On',
  'At',
  'For',
  'To',
  'And',
  'Em',
  'Tôi',
]);

/** capitalized proper-noun-looking tokens NOT at sentence start (React, Node, Kafka, PostgreSQL). */
function properTokens(text: string): string[] {
  const out: string[] = [];
  for (const sentence of text.split(/[.!?…\n]+/)) {
    const toks = sentence.trim().split(/\s+/).filter(Boolean);
    for (let i = 1; i < toks.length; i++) {
      const raw = toks[i].replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      if (raw.length >= 2 && /^[A-Z][A-Za-z0-9.+#]*$/.test(raw) && !COMMON_CAPS.has(raw))
        out.push(raw);
    }
  }
  return out;
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
  // allowed evidence = the user's facts + words already in the original bullet (the model may reuse those).
  // Match numbers + entities as WHOLE tokens (NOT substrings): a fabricated "30%" must not hide inside a
  // legit "300 users" ('30' ⊂ '300'), which substring matching would wrongly accept.
  const source = `${grounded.facts.join(' ')} ${before}`;
  const allowedNumbers = new Set(source.match(NUMBER_RE) ?? []);
  // split on ANY non-alphanumeric so the allowed set is tokenized the SAME way properTokens splits
  // (e.g. 'Node.js' → 'node','js') — otherwise a grounded 'Node.js' would be wrongly rejected.
  const allowedTokens = new Set(
    source
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );

  // (a) every declared used_fact must be one of the allowed facts.
  for (const uf of model.used_facts) {
    if (!grounded.facts.some((f) => f.toLowerCase() === uf.toLowerCase())) {
      return { ok: false, reason: 'UNGROUNDED', detail: `used_fact not in allowed facts: ${uf}` };
    }
  }
  // (b) every number in `after` must be a number the user actually gave (exact, not a substring).
  for (const num of model.after.match(NUMBER_RE) ?? []) {
    if (!allowedNumbers.has(num)) {
      return { ok: false, reason: 'UNGROUNDED', detail: `fabricated number: ${num}` };
    }
  }
  // (c) every proper-noun/tech entity in `after` must be a whole token from the facts or the original.
  for (const tok of properTokens(model.after)) {
    if (!allowedTokens.has(tok.toLowerCase())) {
      return { ok: false, reason: 'UNGROUNDED', detail: `fabricated entity/tech: ${tok}` };
    }
  }
  return {
    ok: true,
    field_patch: { target: opts.target, before, after: model.after, why: opts.why },
  };
}

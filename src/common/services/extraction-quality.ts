/**
 * assessExtractionQuality — a PURE, deterministic read on how trustworthy the extracted CV text is.
 *
 * WHY: every downstream signal (ATS score, skill match, gap, rewrite, interview) is only as good as
 * the text we pulled out of the file. A 2-column / Canva / scanned PDF can extract as garbled,
 * out-of-order, or mojibake'd text — and then a perfectly good CV scores like a blank one. This
 * function surfaces that risk HONESTLY as a reportable signal + low-confidence flag.
 *
 * It is NOT a gate. The hard gate (CV_CONTENT_INSUFFICIENT, in cv-review.service) still rejects
 * truly empty/junk uploads BEFORE the LLM. extraction_quality NEVER blocks scoring and NEVER touches
 * overall_score — it is appended to the review purely so the FE can warn the user to double-check the
 * parsed output. No LLM, no I/O, no Date.now/random.
 *
 * Confidence thresholds (hand-picked, validated on synthetic golden cases + a thin real-CV corpus —
 * re-tune once a layout-diverse corpus exists; see eval:extractors disclaimer):
 *   LOW    : mojibake_ratio > 0.02  OR  wordlike_ratio < 0.55  OR  char_count < 200  OR  ocr_used
 *   MEDIUM : mojibake_ratio > 0.005 OR  wordlike_ratio < 0.72  OR  section_count < 3
 *            OR  no contact anchor (name AND email both missing — an OpenResume-style parse-failure
 *            proxy: a real CV almost always yields at least one, so neither surviving parse == suspect)
 *   HIGH   : everything else
 */
import { CanonicalCvDocument } from '../types/canonical-cv';
import { computeTextMetrics } from './text-metrics';

export type ExtractionConfidence = 'high' | 'medium' | 'low';

/** TRUST' T1 trust verdict the UI gates the score on:
 *  - usable:   score normally.
 *  - suspect:  score, but the UI MUST warn (one hard signal, or supporting-only signals).
 *  - unusable: MULTIPLE hard signals agree the text can't be trusted → the UI must NOT show a
 *    normal score without a prominent warning. A missing contact anchor alone can never reach here. */
export type InputQuality = 'usable' | 'suspect' | 'unusable';

/** Hard signals — each one alone means "double-check" (suspect); two agreeing means "unusable". */
const HARD_FLAGS = new Set(['MOJIBAKE_HIGH', 'WORDLIKE_LOW', 'THIN_CONTENT', 'OCR_USED']);
/** Supporting signals — enough for suspect, NEVER enough alone for unusable (Codex correction #2). */
const SUPPORTING_FLAGS = new Set([
  'MOJIBAKE_SLIGHT',
  'WORDLIKE_WEAK',
  'SPARSE_SECTIONS',
  'NO_CONTACT_ANCHOR',
]);

/** Pure classifier: 3-state trust verdict from the machine flags. unusable requires ≥2 hard signals
 *  to agree, so a single low-confidence signal (e.g. clean OCR) stays suspect, not unusable. */
export function classifyInputQuality(flags: string[]): InputQuality {
  const hard = flags.filter((f) => HARD_FLAGS.has(f)).length;
  if (hard >= 2) return 'unusable';
  if (hard === 1 || flags.some((f) => SUPPORTING_FLAGS.has(f))) return 'suspect';
  return 'usable';
}

export interface ExtractionQuality {
  char_count: number;
  word_count: number;
  mojibake_count: number;
  /** mojibakeCount / charCount, round3. */
  mojibake_ratio: number;
  /** word-like tokens / total tokens, round3. Low ⇒ garbled/columnar text. */
  wordlike_ratio: number;
  /** non-empty CanonicalCvDocument sections (contact/summary/education/experience/projects/skills/certs/activities). */
  section_count: number;
  /** distinct canonical skills found in the text (via injected scan) — falls back to declared skills count. */
  skill_count: number;
  ocr_used: boolean;
  confidence: ExtractionConfidence;
  /** 3-state trust verdict derived from `flags` — the field the UI gates the score on (T1). */
  input_quality: InputQuality;
  /** Machine-readable signals that fired — NEVER fabricated, each maps to a true condition. */
  flags: string[];
}

export interface ExtractionQualityOpts {
  /** True when the text came from image OCR (Tesseract) rather than a real text layer. */
  ocrUsed?: boolean;
  /** Skill gazetteer scan; when omitted, skill_count falls back to the document's declared skills. */
  scan?: (t: string) => { canonical_name: string }[];
}

const MOJIBAKE_HIGH = 0.02;
const MOJIBAKE_SLIGHT = 0.005;
const WORDLIKE_LOW = 0.55;
const WORDLIKE_WEAK = 0.72;
const THIN_CHARS = 200;
const SPARSE_SECTIONS = 3;

/** Count NON-EMPTY sections directly from the structured document — never regex on raw text. */
function countSections(doc: CanonicalCvDocument): number {
  let n = 0;
  if (doc.contact.name || doc.contact.email) n += 1;
  if (doc.summary.trim().length > 0) n += 1;
  if (doc.education.length > 0) n += 1;
  if (doc.experience.length > 0) n += 1;
  if (doc.projects.length > 0) n += 1;
  if (doc.certifications.length > 0) n += 1;
  if (doc.activities.length > 0) n += 1;
  const s = doc.skills;
  if (s.technical.length + s.soft.length + s.languages.length + s.tools.length > 0) n += 1;
  return n;
}

function declaredSkillCount(doc: CanonicalCvDocument): number {
  const s = doc.skills;
  return s.technical.length + s.soft.length + s.languages.length + s.tools.length;
}

export function assessExtractionQuality(
  text: string,
  document: CanonicalCvDocument,
  opts: ExtractionQualityOpts = {},
): ExtractionQuality {
  const ocr_used = opts.ocrUsed ?? false;
  const metrics = computeTextMetrics(text, opts.scan ?? (() => []));
  const section_count = countSections(document);
  const skill_count = opts.scan ? metrics.skillsFound : declaredSkillCount(document);
  // OpenResume-style cheap parse-failure proxy: a well-formed CV almost always yields a name or an
  // email; losing BOTH usually means the parser mis-read the layout, not that the CV lacks contact.
  const no_contact_anchor = !document.contact.name && !document.contact.email;

  const flags: string[] = [];
  if (ocr_used) flags.push('OCR_USED');
  if (metrics.mojibakeRatio > MOJIBAKE_HIGH) flags.push('MOJIBAKE_HIGH');
  else if (metrics.mojibakeRatio > MOJIBAKE_SLIGHT) flags.push('MOJIBAKE_SLIGHT');
  if (metrics.charCount < THIN_CHARS) flags.push('THIN_CONTENT');
  if (metrics.wordlikeRatio < WORDLIKE_LOW) flags.push('WORDLIKE_LOW');
  else if (metrics.wordlikeRatio < WORDLIKE_WEAK) flags.push('WORDLIKE_WEAK');
  if (section_count < SPARSE_SECTIONS) flags.push('SPARSE_SECTIONS');
  if (no_contact_anchor) flags.push('NO_CONTACT_ANCHOR');

  let confidence: ExtractionConfidence = 'high';
  if (
    metrics.mojibakeRatio > MOJIBAKE_HIGH ||
    metrics.wordlikeRatio < WORDLIKE_LOW ||
    metrics.charCount < THIN_CHARS ||
    ocr_used
  ) {
    confidence = 'low';
  } else if (
    metrics.mojibakeRatio > MOJIBAKE_SLIGHT ||
    metrics.wordlikeRatio < WORDLIKE_WEAK ||
    section_count < SPARSE_SECTIONS ||
    no_contact_anchor
  ) {
    confidence = 'medium';
  }

  return {
    char_count: metrics.charCount,
    word_count: metrics.wordCount,
    mojibake_count: metrics.mojibakeCount,
    mojibake_ratio: metrics.mojibakeRatio,
    wordlike_ratio: metrics.wordlikeRatio,
    section_count,
    skill_count,
    ocr_used,
    confidence,
    input_quality: classifyInputQuality(flags),
    flags,
  };
}

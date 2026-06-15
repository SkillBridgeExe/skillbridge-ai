/**
 * PURE deterministic CV Profile Signals (PR3b). No NestJS DI, no IO/LLM/Date.now/Math.random.
 *
 * The CV-side mirror of `jd-dimensions.ts`. For the four non-seniority JD dimensions
 * (language/education/domain/work_mode) it derives a CV-side signal from the ALREADY-parsed
 * `CanonicalCvDocument`, so a later PR can grade them into GapItems the way `gradeSeniority`
 * grades the seniority dimension today.
 *
 * ⚠️ ANTI-FABRICATION (load-bearing — adversarially reviewed): every helper returns `null` when the
 * CV gives no clear signal — never a default. Specifically: numeric tests must be ACHIEVED scores on
 * the right scale (aspirations/targets, durations, sub-test scales, and stray years are rejected);
 * textual/CEFR cues must be ADJACENT to an explicit english cue (no cross-language contamination,
 * negation, or unrelated adjectives); domain/work_mode require specific multi-word anchors, not
 * generic engineering vocabulary. It NEVER touches any score; PR3b only fills `cv_signal` disclosure.
 *
 * Shape mirrors `CvSeniority` (value + `confidence` + `signals[]`). Confidence: explicit test score /
 * CEFR / degree keyword = high; school-inferred degree = medium; textual / keyword-only = low.
 * English level mapping uses the official Cambridge/IELTS and ETS/TOEIC (Listening+Reading) → CEFR
 * alignments. Vietnamese diacritics need explicit Unicode boundaries (JS `\b` is ASCII-only).
 */
import { CanonicalCvDocument } from '../types/canonical-cv';
import { Confidence } from './seniority';

export type SignalConfidence = Confidence; // 'low' | 'medium' | 'high'
export type Cefr = 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2';
const CEFR_RANK: Record<Cefr, number> = { A1: 1, A2: 2, B1: 3, B2: 4, C1: 5, C2: 6 };
const CONF_RANK: Record<SignalConfidence, number> = { low: 0, medium: 1, high: 2 };

export type EnglishSourceKind = 'ielts' | 'toeic' | 'cefr' | 'textual';
export interface CvEnglishSignal {
  cefr: Cefr;
  source_kind: EnglishSourceKind;
  raw: string;
  confidence: SignalConfidence;
  signals: string[];
}

export type DegreeLevel = 'high_school' | 'associate' | 'bachelor' | 'master' | 'phd';
const DEGREE_RANK: Record<DegreeLevel, number> = {
  high_school: 1,
  associate: 2,
  bachelor: 3,
  master: 4,
  phd: 5,
};
export interface CvEducationSignal {
  level: DegreeLevel | null;
  field: string | null;
  confidence: SignalConfidence;
  signals: string[];
}

export interface CvDomainSignal {
  domains: string[];
  confidence: SignalConfidence;
  signals: string[];
}

export type WorkMode = 'remote' | 'hybrid' | 'onsite';
export interface CvWorkModeSignal {
  mode: WorkMode;
  confidence: SignalConfidence;
  signals: string[];
}

export interface CvProfileSignals {
  english: CvEnglishSignal | null;
  education: CvEducationSignal | null;
  domain: CvDomainSignal | null;
  work_mode: CvWorkModeSignal | null;
}

// ── english ────────────────────────────────────────────────────────────────
/** IELTS overall band → CEFR (Cambridge/IELTS alignment). Below the official B1 floor (4.0) we do
 *  NOT assert a band — returns null — which also blocks stray small integers (a "2" from "2 years"). */
function ieltsToCefr(score: number): Cefr | null {
  if (Number.isNaN(score) || score < 4 || score > 9) return null;
  if (score >= 8.5) return 'C2';
  if (score >= 7.0) return 'C1';
  if (score >= 5.5) return 'B2';
  return 'B1'; // 4.0–5.0
}
/** TOEIC Listening+Reading total (10–990) → CEFR (ETS alignment). Out-of-range → null. The CALLER
 *  must gate out Speaking/Writing/Bridge (different scales) before using this. */
function toeicToCefr(score: number): Cefr | null {
  if (Number.isNaN(score) || score < 10 || score > 990) return null;
  if (score >= 945) return 'C1';
  if (score >= 785) return 'B2';
  if (score >= 550) return 'B1';
  if (score >= 225) return 'A2';
  return 'A1';
}

/** An aspiration/preparation qualifier near the test keyword ⇒ not an ACHIEVED score ⇒ reject. */
const ASPIRATION =
  /\btarget\b|\baim(ing)?\b|\bgoal\b|\bexpected\b|\bpreparing\b|\bprep\b|\bpreparation\b|studying for|dự kiến|du kien|mục tiêu|muc tieu|chuẩn bị|chuan bi|ôn thi|on thi|ôn luyện|on luyen/u;
/** A duration/time unit immediately AFTER a number ⇒ it's a duration, not a band ⇒ skip that number. */
const DURATION_AFTER =
  /^\s*(years?|yrs?|months?|tháng|thang|năm|nam|weeks?|tuần|tuan|hours?|giờ|gio|days?|ngày|ngay)\b/u;

/** 40-char window after `keyword`, or null when the keyword is absent. */
function windowAfter(lower: string, keyword: string): string | null {
  const idx = lower.indexOf(keyword);
  return idx === -1 ? null : lower.slice(idx + keyword.length, idx + keyword.length + 40);
}

/**
 * IELTS OVERALL band (0–9) from the window. Honest about notation:
 *  - "6.5/9.0" (score/max) → the numerator (6.5), never the max.
 *  - "overall/band X" → X.
 *  - otherwise a single band-shaped number (decimals preferred); ambiguous-multiple → null.
 * Aspirations are rejected and durations skipped so a "2 years" never becomes a band.
 */
function parseIeltsScore(window: string): number | null {
  if (ASPIRATION.test(window)) return null;
  const sm = window.match(/(\d(?:[.,]\d)?)\s*\/\s*9(?:[.,]0)?(?![\d.])/u);
  if (sm) return parseFloat(sm[1].replace(',', '.'));
  const lbl = window.match(/(?:overall|band|tổng|tong)\D{0,6}(\d(?:[.,]\d)?)/u);
  if (lbl) return parseFloat(lbl[1].replace(',', '.'));
  const nums: Array<{ v: number; dec: boolean }> = [];
  const re = /\d(?:[.,]\d)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(window)) !== null) {
    if (DURATION_AFTER.test(window.slice(re.lastIndex))) continue;
    const v = parseFloat(m[0].replace(',', '.'));
    if (v >= 1 && v <= 9) nums.push({ v, dec: /[.,]/.test(m[0]) });
  }
  const pool = nums.some((n) => n.dec) ? nums.filter((n) => n.dec) : nums;
  return pool.length === 1 ? pool[0].v : null;
}

/**
 * TOEIC Listening+Reading TOTAL (10–990) from the window. Honest about notation:
 *  - "750/990" (score/max) → the numerator (750).
 *  - explicit total "= 975" / "total 975" → that total.
 *  - both "Listening N" and "Reading M" present, each in 5–495 → the intentional sum (out-of-range → null).
 *  - a SINGLE labelled section (only Listening OR only Reading) → null (a section ≠ a total).
 *  - otherwise a single bare number → it; ambiguous-multiple → null.
 * The CALLER gates out Speaking/Writing/Bridge (different scales) before calling this.
 */
function parseToeicScore(window: string): number | null {
  if (ASPIRATION.test(window)) return null;
  const sm = window.match(/(\d{2,4})\s*\/\s*990(?!\d)/u);
  if (sm) return parseInt(sm[1], 10);
  const total = window.match(/(?:=|total|tổng|tong)\D{0,4}(\d{2,4})/u);
  if (total) return parseInt(total[1], 10);
  const hasL = /listening/u.test(window);
  const hasR = /reading/u.test(window);
  if (hasL && hasR) {
    const l = window.match(/listening\D{0,6}(\d{1,4})/u);
    const r = window.match(/reading\D{0,6}(\d{1,4})/u);
    if (!l || !r) return null;
    const lv = parseInt(l[1], 10);
    const rv = parseInt(r[1], 10);
    // Each TOEIC L/R section is scored 5–495; an out-of-range section is not a real score, so do
    // NOT sum it into a fake total — return null.
    if (lv < 5 || lv > 495 || rv < 5 || rv > 495) return null;
    return lv + rv;
  }
  if (hasL || hasR) return null;
  const nums: number[] = [];
  const re = /\d{2,4}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(window)) !== null) {
    if (DURATION_AFTER.test(window.slice(re.lastIndex))) continue;
    nums.push(parseInt(m[0], 10));
  }
  return nums.length === 1 ? nums[0] : null;
}

// CEFR/textual cues must sit ADJACENT to an english cue, separated only by spaces/punctuation (NOT a
// comma/clause break — that would let another language's level leak in: "French - fluent, English - basic").
const ENG = '(?:english|tiếng anh|tieng anh)';
const SEP = '[\\s:()\\-–—]{1,4}';
const NB = '(?![\\p{L}\\p{N}])'; // right boundary
const NBB = '(?<![\\p{L}\\p{N}])'; // left boundary

function cefrAdjacentToEnglish(lower: string): Cefr | null {
  const after = lower.match(new RegExp(`${ENG}${SEP}(a1|a2|b1|b2|c1|c2)${NB}`, 'u'));
  if (after) return after[1].toUpperCase() as Cefr;
  const before = lower.match(new RegExp(`${NBB}(a1|a2|b1|b2|c1|c2)${SEP}${ENG}`, 'u'));
  if (before) return before[1].toUpperCase() as Cefr;
  return null;
}

function textualAdjacentToEnglish(lower: string): Cefr | null {
  const groups: ReadonlyArray<readonly [Cefr, string]> = [
    ['C1', 'fluent|proficient|advanced|thông thạo|thanh thao|lưu loát|luu loat'],
    ['B1', 'intermediate|good|khá|giao tiếp|giao tiep'],
    ['A2', 'basic|beginner|cơ bản|co ban'],
  ];
  for (const [cefr, desc] of groups) {
    const d = `${NBB}(?:${desc})${NB}`;
    if (new RegExp(`${ENG}${SEP}${d}`, 'u').test(lower)) return cefr;
    if (new RegExp(`${d}${SEP}${ENG}`, 'u').test(lower)) return cefr;
  }
  return null;
}

function englishFromString(s: string): CvEnglishSignal | null {
  const raw = s.trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const mk = (
    cefr: Cefr,
    kind: EnglishSourceKind,
    confidence: SignalConfidence,
  ): CvEnglishSignal => ({
    cefr,
    source_kind: kind,
    raw,
    confidence,
    signals: [`language: ${raw}`],
  });

  const iw = windowAfter(lower, 'ielts');
  if (iw !== null) {
    const score = parseIeltsScore(iw);
    const cefr = score !== null ? ieltsToCefr(score) : null;
    if (cefr) return mk(cefr, 'ielts', 'high');
  }

  // TOEIC L&R only — Speaking/Writing/Bridge use different scales, so gate them out (no fabrication).
  const tw = windowAfter(lower, 'toeic');
  if (
    tw !== null &&
    !/speaking|writing|s&w|s & w|bridge|4 skills|four skills|nói|noi|viết|viet/u.test(lower)
  ) {
    const score = parseToeicScore(tw);
    const cefr = score !== null ? toeicToCefr(score) : null;
    if (cefr) return mk(cefr, 'toeic', 'high');
  }

  const cefr = cefrAdjacentToEnglish(lower);
  if (cefr) return mk(cefr, 'cefr', 'high');

  const textual = textualAdjacentToEnglish(lower);
  if (textual) return mk(textual, 'textual', 'low');

  return null;
}

export function deriveCvEnglishLevel(doc: CanonicalCvDocument): CvEnglishSignal | null {
  const sources = [
    ...(doc.skills?.languages ?? []),
    ...(doc.certifications ?? []).map((c) => c?.name).filter((n): n is string => !!n),
  ];
  const candidates = sources
    .map(englishFromString)
    .filter((x): x is CvEnglishSignal => x !== null)
    .sort(
      (a, b) =>
        CONF_RANK[b.confidence] - CONF_RANK[a.confidence] || CEFR_RANK[b.cefr] - CEFR_RANK[a.cefr],
    );
  return candidates[0] ?? null;
}

// ── education ────────────────────────────────────────────────────────────────
// high_school BEFORE associate so "High School Diploma" is not mis-read as associate via /diploma/.
// Bare "diploma" is dropped (covers bootcamp/attendance diplomas); "master(?!ing)" avoids "Mastering X".
const DEGREE_PATTERNS: ReadonlyArray<readonly [DegreeLevel, RegExp]> = [
  ['phd', /ph\.?d|doctora(l|te)|tiến sĩ|tien si/u],
  ['master', /thạc sĩ|thac si|\bmba\b|\bm\.?sc\b|\bm\.?eng\b|master(?!ing)/u],
  [
    'bachelor',
    /bachelor|\bb\.?sc\b|\bb\.?eng\b|cử nhân|cu nhan|kỹ sư|ky su|đại học|dai hoc|engineer'?s degree/u,
  ],
  ['high_school', /high school|secondary school|thpt|trung học phổ thông|trung hoc pho thong/u],
  ['associate', /associate|cao đẳng|cao dang|\bcollege\b/u],
];

function classifyDegree(text: string): DegreeLevel | null {
  const lower = text.toLowerCase();
  for (const [level, re] of DEGREE_PATTERNS) if (re.test(lower)) return level;
  return null;
}

export function deriveCvEducation(doc: CanonicalCvDocument): CvEducationSignal | null {
  const edus = doc.education ?? [];
  if (edus.length === 0) return null;

  let bestLevel: DegreeLevel | null = null;
  let bestConf: SignalConfidence = 'low';
  let field: string | null = null;
  const signals: string[] = [];

  for (const e of edus) {
    if (!field && e.field) field = e.field.trim();
    let level = e.degree ? classifyDegree(e.degree) : null;
    let conf: SignalConfidence = level ? 'high' : 'low';
    // Infer ONLY when no degree string was supplied. Check high-school FIRST so a school literally
    // named "... High School" (even with "University" in it) is never upgraded to bachelor.
    if (!level && !e.degree) {
      const school = (e.school ?? '').toLowerCase();
      if (/high school|secondary school|thpt|trung học/u.test(school)) {
        level = 'high_school';
        conf = 'low';
      } else if (/university|đại học|dai hoc/u.test(school)) {
        level = 'bachelor';
        conf = 'medium';
      } else if (/\bcollege\b|cao đẳng|cao dang/u.test(school)) {
        level = 'associate';
        conf = 'medium';
      }
    }
    if (level) {
      signals.push(`education: ${[e.degree, e.school].filter(Boolean).join(' @ ') || level}`);
      const rank = DEGREE_RANK[level];
      if (bestLevel === null || rank > DEGREE_RANK[bestLevel]) {
        bestLevel = level;
        bestConf = conf;
      } else if (rank === DEGREE_RANK[bestLevel] && CONF_RANK[conf] > CONF_RANK[bestConf]) {
        bestConf = conf; // a same-level explicit degree upgrades an inferred one
      }
    }
  }

  if (bestLevel === null) {
    return field
      ? { level: null, field, confidence: 'low', signals: [`education: field ${field}`] }
      : null;
  }
  return { level: bestLevel, field, confidence: bestConf, signals };
}

// ── domain ────────────────────────────────────────────────────────────────
// Multi-word / specific anchors only — bare generic dev words (delivery, shipping, payment, trading,
// wallet, game, messaging, retail, booking, "education") fabricate industries from ordinary prose.
const DOMAIN_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  [
    'ecommerce',
    /e-?commerce|thương mại điện tử|thuong mai dien tu|marketplace|shopping cart|giỏ hàng|sàn thương mại/u,
  ],
  [
    // No bare "payment"/"thanh toán" — those are e-commerce checkout, not the fintech industry.
    // Require an explicit banking/wallet/gateway/securities anchor.
    'fintech',
    /fintech|payment gateway|payment processing|cổng thanh toán|ví điện tử|vi dien tu|e-wallet|digital banking|ngân hàng số|sàn giao dịch|chứng khoán|chung khoan|insurtech|lending platform/u,
  ],
  [
    'healthcare',
    /health\s?care|healthtech|medical|y tế|y te|hospital|bệnh viện|benh vien|clinic|phòng khám|phong kham|telemedicine|pharma/u,
  ],
  [
    'education',
    /edtech|e-?learning|\blms\b|learning management|khóa học trực tuyến|nền tảng giáo dục|tutoring platform/u,
  ],
  [
    'logistics',
    /logistics|supply chain|chuỗi cung ứng|chuoi cung ung|last-mile|warehouse|kho bãi|fleet|fulfillment|giao nhận|vận chuyển|van chuyen/u,
  ],
  ['social', /social network|mạng xã hội|mang xa hoi|social media|chat app|messaging platform/u],
  [
    // No bare "Unity"/"Unreal" — those engines are used for AR/VR/training/sims, not only games.
    'gaming',
    /game development|gamedev|game studio|trò chơi điện tử|phát triển game/u,
  ],
  [
    'travel',
    /travel booking|online travel|\bota\b|airline|hotel booking|đặt phòng|đặt vé|du lịch trực tuyến|tour operator/u,
  ],
];

export function deriveCvDomain(doc: CanonicalCvDocument): CvDomainSignal | null {
  const texts: string[] = [doc.summary ?? ''];
  for (const e of doc.experience ?? []) texts.push(e.org ?? '', e.role ?? '', ...(e.bullets ?? []));
  for (const p of doc.projects ?? [])
    texts.push(p.name ?? '', ...(p.bullets ?? []), ...(p.tech ?? []));
  const hay = texts.join(' \n ').toLowerCase();

  const domains = DOMAIN_PATTERNS.filter(([, re]) => re.test(hay)).map(([dom]) => dom);
  if (domains.length === 0) return null;
  domains.sort();
  return {
    domains,
    confidence: domains.length >= 2 ? 'medium' : 'low',
    signals: domains.map((d) => `domain:${d}`),
  };
}

// ── work_mode ────────────────────────────────────────────────────────────────
// LOCATION field ONLY — scanning achievement bullets fabricates a work mode from technical jargon
// ("remote git", "hybrid cloud", "kết hợp công nghệ"). Require employment-mode phrasing.
const WORKMODE_PATTERNS: ReadonlyArray<readonly [WorkMode, RegExp]> = [
  ['remote', /\bremote\b|làm việc từ xa|lam viec tu xa|work from home|\bwfh\b|remote-first/u],
  ['hybrid', /\bhybrid\b|làm việc kết hợp|lam viec ket hop/u],
  ['onsite', /\bon-?site\b|tại văn phòng|tai van phong|tại công ty|tai cong ty/u],
];

export function deriveCvWorkMode(doc: CanonicalCvDocument): CvWorkModeSignal | null {
  const hay = (doc.experience ?? []).map((e) => (e.location ?? '').toLowerCase()).join(' \n ');
  const distinct = [...new Set(WORKMODE_PATTERNS.filter(([, re]) => re.test(hay)).map(([m]) => m))];
  // Only assert a mode when the signal is consistent — conflicting modes (e.g. Remote + On-site) → null.
  if (distinct.length !== 1) return null;
  return { mode: distinct[0], confidence: 'low', signals: [`work_mode:${distinct[0]}`] };
}

// ── aggregator ────────────────────────────────────────────────────────────────
export function deriveCvProfileSignals(doc: CanonicalCvDocument): CvProfileSignals {
  return {
    english: deriveCvEnglishLevel(doc),
    education: deriveCvEducation(doc),
    domain: deriveCvDomain(doc),
    work_mode: deriveCvWorkMode(doc),
  };
}

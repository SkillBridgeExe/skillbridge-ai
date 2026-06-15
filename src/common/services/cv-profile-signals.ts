/**
 * PURE deterministic CV Profile Signals (PR3b). No NestJS DI, no IO/LLM/Date.now/Math.random.
 *
 * The CV-side mirror of `jd-dimensions.ts`. For the four non-seniority JD dimensions
 * (language/education/domain/work_mode) it derives a CV-side signal from the ALREADY-parsed
 * `CanonicalCvDocument`, so a later PR can grade them into GapItems the way `gradeSeniority`
 * grades the seniority dimension today.
 *
 * ⚠️ ANTI-FABRICATION (load-bearing): every helper returns `null` when the CV gives no clear
 * signal — never a default. It NEVER touches any score; PR3b only fills the `cv_signal` disclosure
 * field. (Seniority is handled separately by `deriveCvSeniority` in seniority.ts.)
 *
 * Shape mirrors `CvSeniority` (value + `confidence` + `signals[]`). Confidence: explicit test
 * score / CEFR / degree keyword = high; school-inferred degree = medium; textual / keyword-only =
 * low. English level mapping uses the official Cambridge/IELTS and ETS/TOEIC → CEFR alignments.
 */
import { CanonicalCvDocument } from '../types/canonical-cv';
import { Confidence } from './seniority';

export type SignalConfidence = Confidence; // 'low' | 'medium' | 'high'
export type Cefr = 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2';
const CEFR_RANK: Record<Cefr, number> = { A1: 1, A2: 2, B1: 3, B2: 4, C1: 5, C2: 6 };

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

const CONF_RANK: Record<SignalConfidence, number> = { low: 0, medium: 1, high: 2 };

// ── english ────────────────────────────────────────────────────────────────
/** IELTS overall band → CEFR (Cambridge/IELTS alignment). Out-of-range → null. */
function ieltsToCefr(score: number): Cefr | null {
  if (Number.isNaN(score) || score < 1 || score > 9) return null;
  if (score >= 8.5) return 'C2';
  if (score >= 7.0) return 'C1';
  if (score >= 5.5) return 'B2';
  if (score >= 4.0) return 'B1';
  return 'A2';
}
/** TOEIC Listening+Reading total (10–990) → CEFR (ETS alignment). Out-of-range → null. */
function toeicToCefr(score: number): Cefr | null {
  if (Number.isNaN(score) || score < 10 || score > 990) return null;
  if (score >= 945) return 'C1';
  if (score >= 785) return 'B2';
  if (score >= 550) return 'B1';
  if (score >= 225) return 'A2';
  return 'A1';
}

const EN_CUE = /english|tiếng anh|tieng anh/u;
const CEFR_TOKEN = /(?<![\p{L}\p{N}])(a1|a2|b1|b2|c1|c2)(?![\p{L}\p{N}])/u;

/** Conservative textual descriptor → CEFR (LOW confidence). Only used when an english cue is present. */
function textualToCefr(lower: string): Cefr | null {
  if (/fluent|proficient|advanced|thông thạo|thanh thao|lưu loát|luu loat/u.test(lower))
    return 'C1';
  if (/intermediate|good|giao tiếp|giao tiep|khá|\bkha\b/u.test(lower)) return 'B1';
  if (/basic|beginner|cơ bản|co ban/u.test(lower)) return 'A2';
  return null;
}

/**
 * First numeric token within a short window after `keyword` (tolerates "IELTS Academic 7.0",
 * "TOEIC L&R: 750"). Out-of-range scores are rejected downstream by the band mappers, so a stray
 * year ("…in 2024") maps to null rather than a fabricated band.
 */
function scoreAfter(lower: string, keyword: string): number | null {
  const idx = lower.indexOf(keyword);
  if (idx === -1) return null;
  const window = lower.slice(idx + keyword.length, idx + keyword.length + 30);
  const m = window.match(/(\d{1,4}(?:[.,]\d)?)/);
  return m ? parseFloat(m[1].replace(',', '.')) : null;
}

function englishFromString(s: string): CvEnglishSignal | null {
  const raw = s.trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const mkSignal = `language: ${raw}`;

  const ielts = scoreAfter(lower, 'ielts');
  if (ielts !== null) {
    const cefr = ieltsToCefr(ielts);
    if (cefr) return { cefr, source_kind: 'ielts', raw, confidence: 'high', signals: [mkSignal] };
  }
  const toeic = scoreAfter(lower, 'toeic');
  if (toeic !== null) {
    const cefr = toeicToCefr(toeic);
    if (cefr) return { cefr, source_kind: 'toeic', raw, confidence: 'high', signals: [mkSignal] };
  }
  // CEFR token & textual require an english cue (so "Bằng lái xe B2" never reads as english).
  if (EN_CUE.test(lower)) {
    const band = lower.match(CEFR_TOKEN);
    if (band)
      return {
        cefr: band[1].toUpperCase() as Cefr,
        source_kind: 'cefr',
        raw,
        confidence: 'high',
        signals: [mkSignal],
      };
    const textual = textualToCefr(lower);
    if (textual)
      return { cefr: textual, source_kind: 'textual', raw, confidence: 'low', signals: [mkSignal] };
  }
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
const DEGREE_PATTERNS: ReadonlyArray<readonly [DegreeLevel, RegExp]> = [
  ['phd', /ph\.?d|doctor(al|ate)?|tiến sĩ|tien si/u],
  ['master', /master|m\.?sc|m\.?eng|\bmba\b|thạc sĩ|thac si/u],
  [
    'bachelor',
    /bachelor|b\.?sc|b\.?eng|cử nhân|cu nhan|kỹ sư|ky su|đại học|dai hoc|engineer'?s degree/u,
  ],
  ['associate', /associate|cao đẳng|cao dang|diploma/u],
  ['high_school', /high school|thpt|trung học phổ thông|trung hoc pho thong|secondary school/u],
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
    if (!level && !e.degree) {
      const school = (e.school ?? '').toLowerCase();
      if (/university|đại học|dai hoc/u.test(school)) {
        level = 'bachelor';
        conf = 'medium';
      } else if (/college|cao đẳng|cao dang/u.test(school)) {
        level = 'associate';
        conf = 'medium';
      }
    }
    if (level) {
      signals.push(`education: ${[e.degree, e.school].filter(Boolean).join(' @ ') || level}`);
      if (bestLevel === null || DEGREE_RANK[level] > DEGREE_RANK[bestLevel]) {
        bestLevel = level;
        bestConf = conf;
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
const DOMAIN_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  [
    'ecommerce',
    /e-?commerce|thương mại điện tử|thuong mai dien tu|marketplace|shopping cart|\bcheckout\b|\bcart\b|retail/u,
  ],
  [
    'fintech',
    /fintech|banking|ngân hàng|ngan hang|payment|thanh toán|thanh toan|wallet|ví điện tử|vi dien tu|lending|trading|chứng khoán|chung khoan|insurance|insurtech/u,
  ],
  [
    'healthcare',
    /health\s?care|healthtech|medical|y tế|y te|hospital|bệnh viện|benh vien|clinic|phòng khám|phong kham|patient|pharma/u,
  ],
  [
    'education',
    /\beducation\b|edtech|e-?learning|\blms\b|giáo dục|giao duc|trường học|truong hoc|tutoring/u,
  ],
  [
    'logistics',
    /logistics|shipping|giao hàng|giao hang|delivery|warehouse|supply chain|chuỗi cung ứng|chuoi cung ung/u,
  ],
  ['social', /social network|mạng xã hội|mang xa hoi|messaging|chat app/u],
  ['gaming', /\bgame\b|gaming|trò chơi|tro choi/u],
  ['travel', /\btravel\b|du lịch|du lich|hotel|khách sạn|khach san|\bflight\b|\btour\b|booking/u],
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
const WORKMODE_PATTERNS: ReadonlyArray<readonly [WorkMode, RegExp]> = [
  ['remote', /\bremote\b|làm việc từ xa|lam viec tu xa|work from home|\bwfh\b|từ xa|tu xa/u],
  ['hybrid', /\bhybrid\b|kết hợp|ket hop/u],
  ['onsite', /\bon-?site\b|tại văn phòng|tai van phong|tại công ty|tai cong ty/u],
];

export function deriveCvWorkMode(doc: CanonicalCvDocument): CvWorkModeSignal | null {
  const texts: string[] = [];
  for (const e of doc.experience ?? []) texts.push(e.location ?? '', ...(e.bullets ?? []));
  const hay = texts.join(' \n ').toLowerCase();
  for (const [mode, re] of WORKMODE_PATTERNS) {
    if (re.test(hay)) return { mode, confidence: 'low', signals: [`work_mode:${mode}`] };
  }
  return null;
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

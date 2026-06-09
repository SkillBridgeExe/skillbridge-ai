import { Injectable } from '@nestjs/common';
import { CanonicalCvDocument } from '../../common/types/canonical-cv';

/**
 * Deterministic Dimension-1 analyzer (Action Verbs & Quantified Impact).
 *
 * Counting verb-first bullets, quantified bullets, passive/first-person/filler is a
 * MECHANICAL FACT — code computes it exactly and reproducibly, whereas the LLM only
 * *estimates* these counts (cv_review_v1.md asks it to guess "≥80% of bullets…").
 * So we move this dimension to code (see docs/cv-scoring-architecture.md, N1).
 *
 * Criteria grounded in docs/cv-scoring-methodology.md (Columbia/MIT/Harvard/Fresno):
 *   - every bullet should start with a STRONG action verb (active, not "Responsible for…")
 *   - quantify where a real number exists, but a qualitative result is acceptable —
 *     quantification is NOT mandatory on every bullet; the working threshold is ~50%.
 *
 * Bilingual (EN + VI). Returns a 0-20 score (Fresno 4-level bands) PLUS the raw signals,
 * so the score is fully explainable and the signals feed the calibration spine as
 * trustworthy (non-LLM) labels.
 */

export interface BulletSignals {
  bulletCount: number;
  /** Fraction of bullets that START with a strong action verb (and not a weak duty opener). */
  verbFirstRatio: number;
  /** Fraction of bullets containing a quantified result (number/%/$/unit). */
  quantifiedRatio: number;
  /** Fraction of bullets opening with a weak/passive/duty phrase ("Responsible for…"). */
  weakOpenerRatio: number;
  /** Fraction of bullets using first-person ("I", "tôi", "em"). */
  firstPersonRatio: number;
  /** Count of filler/buzzword occurrences across all bullets. */
  fillerCount: number;
}

export type BulletBand = 'exemplary' | 'accomplished' | 'developing' | 'beginning';

export interface BulletAnalysis extends BulletSignals {
  /** Deterministic Dimension-1 score, 0-20. */
  actionVerbsScore: number;
  band: BulletBand;
  notes: string[];
}

export interface BulletFeedbackItem {
  text: string;
  section: 'experience' | 'projects' | 'activities';
  verbFirst: boolean;
  quantified: boolean;
  weakOpener: boolean;
  firstPerson: boolean;
  fillerCount: number;
  tips: string[];
}

/** Per-line flags for ONE bullet/sentence — used by the cv-builder live evaluator (R1b). */
export interface LineCheck {
  /** Starts with a strong action verb (and not a weak duty opener). */
  verbFirst: boolean;
  /** Contains a quantified result (number/%/$/unit, or bare number + impact cue). */
  quantified: boolean;
  /** Opens with a weak/passive/duty phrase ("Responsible for…", "Phụ trách…"). */
  weakOpener: boolean;
  /** Uses first-person ("my", "tôi", "em" — VI markers only on vi). */
  firstPerson: boolean;
  /** Filler/buzzword occurrences ("hardworking", "nhiệt tình", …). */
  fillerCount: number;
}

// ─── Lexicons (lowercased) ───────────────────────────────────────────────────
// Strong action verbs. EN single-word + VI single/two-word (VI verbs are often 2 words).
const STRONG_VERBS_EN = new Set([
  'built',
  'build',
  'designed',
  'design',
  'led',
  'lead',
  'optimized',
  'optimize',
  'implemented',
  'implement',
  'developed',
  'develop',
  'created',
  'create',
  'analyzed',
  'analyze',
  'managed',
  'manage',
  'improved',
  'improve',
  'reduced',
  'reduce',
  'increased',
  'increase',
  'launched',
  'launch',
  'automated',
  'automate',
  'architected',
  'delivered',
  'deliver',
  'engineered',
  'refactored',
  'migrated',
  'deployed',
  'integrated',
  'shipped',
  'drove',
  'spearheaded',
  'coordinated',
  'organized',
  'mentored',
  'tested',
  'debugged',
  'scaled',
  'streamlined',
  'established',
  'achieved',
  'won',
  'presented',
  'authored',
  'configured',
  'maintained',
  'researched',
  'wrote',
  'code',
  'coded',
  'redesigned',
  'rebuilt',
  'cut',
  'boosted',
  'accelerated',
  'eliminated',
  'resolved',
  'used',
  'applied',
  'performed',
  // Common IT-resume verbs that were missing (under-scored real CVs, e.g. "Set up…", "Fixed…").
  'set',
  'added',
  'add',
  'fixed',
  'fix',
  'trained',
  'train',
  'tracked',
  'track',
  'monitored',
  'monitor',
  'published',
  'publish',
  'executed',
  'execute',
  'identified',
  'identify',
  'collaborated',
  'collaborate',
  'owned',
  'validated',
  'validate',
  'prototyped',
  'prototype',
  'containerized',
  'orchestrated',
  'provisioned',
  'instrumented',
  'benchmarked',
  'profiled',
  'reviewed',
  'documented',
  'enabled',
  'introduced',
  'standardized',
  'consolidated',
]);
// VI strong verbs — checked against the first 1-2 trimmed words.
const STRONG_VERBS_VI = new Set([
  'xây',
  'xây dựng',
  'phát triển',
  'thiết kế',
  'triển khai',
  'tối ưu',
  'dẫn dắt',
  'quản lý',
  'phân tích',
  'cải thiện',
  'cải tiến',
  'tăng',
  'giảm',
  'tạo',
  'lập trình',
  'hoàn thành',
  'đạt',
  'nghiên cứu',
  'kiểm thử',
  'kiểm tra',
  'đề xuất',
  'tổ chức',
  'phối hợp',
  'đào tạo',
  'tự động hóa',
  'tích hợp',
  'xử lý',
  'khắc phục',
  'nâng cấp',
  'rút ngắn',
  'viết',
  'thiết lập',
  'sử dụng',
  'thực hiện',
  'hiện thực',
  'áp dụng',
  'vận hành',
  'khởi tạo',
  'chuyển đổi',
  'di chuyển',
  'tái cấu trúc',
  'phục vụ',
  'phát hiện',
  'đảm nhận',
  'giám sát',
  'thu thập',
  'tổng hợp',
  'biên soạn',
  'huấn luyện',
  'triển khai',
  'phát hành',
  // Common VI IT-resume verbs that were missing.
  'sửa',
  'sửa lỗi',
  'thêm',
  'theo dõi',
  'kiểm soát',
  'cài đặt',
  'đóng gói',
  'điều phối',
  'xác thực',
  'review',
]);
// Weak/passive duty openers — disqualify a bullet from "verb-first" even if grammatically a verb.
const WEAK_OPENERS_EN = [
  'responsible for',
  'responsible',
  'worked on',
  'worked',
  'helped',
  'assisted',
  'participated',
  'involved',
  'in charge of',
  'tasked with',
  'duties included',
  'was',
  'were',
];
// VI passive/duty openers. "được" at the START marks the passive voice ("Được giao…"); it is
// safe because legitimate verbs like "đạt được" do not START with "được".
const WEAK_OPENERS_VI = [
  'chịu trách nhiệm',
  'phụ trách',
  'tham gia',
  'hỗ trợ',
  'làm việc',
  'được giao',
  'được',
  'có nhiệm vụ',
];
const FILLER_EN = [
  'hardworking',
  'hard-working',
  'team player',
  'results-driven',
  'detail-oriented',
  'go-getter',
  'self-motivated',
  'fast learner',
  'think outside the box',
  'synergy',
  'go getter',
  'passionate',
  'dynamic individual',
];
const FILLER_VI = [
  'chăm chỉ',
  'có trách nhiệm',
  'nhiệt tình',
  'năng động',
  'ham học hỏi',
  'chịu khó',
  'cẩn thận',
  'trung thực',
];
// First-person markers. Bare standalone "i" is intentionally excluded — it false-fires on
// roman numerals / list markers ("Phase I", "Part I"); we keep the unambiguous forms.
const FIRST_PERSON_EN = [
  /\bme\b/,
  /\bmy\b/,
  /\bi'm\b/,
  /\bi am\b/,
  /\bi have\b/,
  /\bi was\b/,
  /\bmyself\b/,
];
// Match VI first-person ONLY as a sentence-leading subject pronoun ("Em phát triển…") or in a
// possessive phrase ("của em"). Bare \bem\b / \bmình\b mid-sentence false-fire on English tech
// terms that appear inside VI CVs ("EM" = CSS unit / Expectation-Maximization), so they are not
// matched anywhere except at the start. ("tôi" is unambiguous, kept as a free marker.)
const FIRST_PERSON_VI = [/\btôi\b/, /của tôi/, /của em/, /của mình/, /^(?:tôi|em|mình)\b/];

// Quantified impact: %, $, "by N", "Nx", "N+", or a number followed by a meaningful unit
// (EN + VI). Decimals supported (99.9%, 1.5x).
const QUANT = new RegExp(
  [
    '\\d+(?:[.,]\\d+)?\\s?%', // 40% / 99.9%
    '[$₫]\\s?\\d', // $5 / ₫5
    'by\\s+\\d', // by 30
    '\\d+(?:[.,]\\d+)?\\s?x\\b', // 3x / 1.5x
    '\\d+\\+', // 20+
    '(?:team|group|squad|cohort|nhóm|đội)\\s+(?:of\\s+)?\\d', // "team of 5" / "nhóm 5" — small-count impact
    // Trailing boundary is a Unicode-aware lookahead (NOT \b — JS \b is ASCII-only and would
    // reject VI units ending in a diacritic, e.g. "200 giờ" / "1 tỷ", systematically
    // under-scoring Vietnamese CVs). It still blocks prefix false-matches like "5 marketing"
    // (the bare "m"/"k" units), because the next char there is a letter.
    '\\b\\d[\\d.,]*\\s*(?:users?|people|persons?|hours?|days?|weeks?|months?|years?|projects?|members?|teams?|customers?|engineers?|developers?|devs?|interns?|juniors?|designers?|testers?|analysts?|clients?|staff|downloads?|requests?|pages?|lines?|commits?|tests?|bugs?|prs?|endpoints?|apis?|features?|tickets?|releases?|screens?|records?|queries|stars?|points?|seconds?|secs?|ms|gb|mb|kb|tb|k|m|million|billion|nghìn|triệu|tỷ|giờ|ngày|tuần|tháng|năm|người|dự án|thành viên|khách hàng|lượt|dòng|bài|lỗi|tính năng|bản ghi|truy vấn|màn hình|điểm|phút|giây|đồng)(?=[^\\p{L}\\d]|$)',
  ].join('|'),
  'iu',
);
// Bare numbers (2-6 digits, not a year) only count as impact when the bullet ALSO shows an
// impact cue — this prevents phone numbers, IDs, room/postal numbers from inflating the score.
// 1-6 digits (year-filtered) — a SINGLE-digit count ("led 5 engineers", "reduced 8 bugs") is the
// most common metric on junior/student CVs; it still only counts as impact behind an impact cue.
const BARE_NUMBER = /\b\d{1,6}\b/g;
const YEAR = /^(?:19|20)\d{2}$/;
const IMPACT_CUE =
  /\b(?:reduc|increas|sav|cut|boost|gr[eo]w|serv|handl|process|improv|rais|lower|achiev|deliver|ship|launch|scal|drop|optimi|reach|grad)/i;
const IMPACT_CUE_VI =
  /(giảm|tăng|tiết kiệm|phục vụ|xử lý|cải thiện|cải tiến|nâng|đạt|tối ưu|hoàn thành|rút ngắn|tiếp cận)/;

@Injectable()
export class BulletAnalyzerService {
  analyze(document: CanonicalCvDocument): BulletAnalysis {
    const bullets = this.harvestBullets(document);
    const n = bullets.length;
    if (n === 0) {
      return {
        bulletCount: 0,
        verbFirstRatio: 0,
        quantifiedRatio: 0,
        weakOpenerRatio: 0,
        firstPersonRatio: 0,
        fillerCount: 0,
        actionVerbsScore: 2,
        band: 'beginning',
        notes: ['No experience/project/activity bullets found to evaluate.'],
      };
    }

    let verbFirst = 0;
    let quantified = 0;
    let weak = 0;
    let firstPerson = 0;
    let filler = 0;

    // VI first-person markers only on vi CVs (avoid "em" false-firing on EN — CSS unit/em-dash).
    const fpMarkers =
      document.language === 'vi' ? [...FIRST_PERSON_EN, ...FIRST_PERSON_VI] : FIRST_PERSON_EN;

    for (const raw of bullets) {
      const b = raw.trim();
      const lower = b.toLowerCase();
      if (this.isWeakOpener(lower)) weak += 1;
      else if (this.isVerbFirst(lower)) verbFirst += 1;
      if (this.isQuantified(b)) quantified += 1;
      if (fpMarkers.some((re) => re.test(lower))) firstPerson += 1;
      filler += this.countFiller(lower);
    }

    const verbFirstRatio = verbFirst / n;
    const quantifiedRatio = quantified / n;
    const weakOpenerRatio = weak / n;
    const firstPersonRatio = firstPerson / n;
    const actionVerbsScore = this.score(verbFirstRatio, quantifiedRatio);

    return {
      bulletCount: n,
      verbFirstRatio: round2(verbFirstRatio),
      quantifiedRatio: round2(quantifiedRatio),
      weakOpenerRatio: round2(weakOpenerRatio),
      firstPersonRatio: round2(firstPersonRatio),
      fillerCount: filler,
      actionVerbsScore,
      band: toBand(actionVerbsScore),
      notes: this.notes(verbFirstRatio, quantifiedRatio, weakOpenerRatio, firstPersonRatio, filler),
    };
  }

  /**
   * Per-line check for ONE bullet/sentence (R1b live evaluator). SAME heuristics as
   * analyze() — single source of truth for the lexicons/regexes. Deterministic.
   */
  checkLine(text: string, language: 'vi' | 'en' = 'en'): LineCheck {
    const b = (text ?? '').trim();
    const lower = b.toLowerCase();
    const fpMarkers =
      language === 'vi' ? [...FIRST_PERSON_EN, ...FIRST_PERSON_VI] : FIRST_PERSON_EN;
    const weakOpener = this.isWeakOpener(lower);
    return {
      weakOpener,
      verbFirst: !weakOpener && this.isVerbFirst(lower),
      quantified: this.isQuantified(b),
      firstPerson: fpMarkers.some((re) => re.test(lower)),
      fillerCount: this.countFiller(lower),
    };
  }

  /** Distinct cliché/buzzword phrases present in the CV's bullets (deterministic; reuses filler lexicon). */
  detectBuzzwords(document: CanonicalCvDocument): string[] {
    const haystack = this.harvestBullets(document).join(' \n ').toLowerCase();
    const found = new Set<string>();
    for (const phrase of [...FILLER_EN, ...FILLER_VI]) {
      if (haystack.includes(phrase)) found.add(phrase);
    }
    return [...found];
  }

  /** Per-bullet deterministic feedback (R1 explainability). Reuses checkLine(); no LLM. */
  analyzeBullets(document: CanonicalCvDocument): BulletFeedbackItem[] {
    const lang: 'vi' | 'en' = document.language === 'vi' ? 'vi' : 'en';
    const sections: Array<
      ['experience' | 'projects' | 'activities', Array<{ bullets?: string[] }>]
    > = [
      ['experience', document.experience ?? []],
      ['projects', document.projects ?? []],
      ['activities', document.activities ?? []],
    ];
    const out: BulletFeedbackItem[] = [];
    for (const [section, entries] of sections) {
      for (const entry of entries) {
        for (const raw of entry.bullets ?? []) {
          const text = (raw ?? '').trim();
          if (!text) continue;
          const c = this.checkLine(text, lang);
          out.push({ text, section, ...c, tips: this.bulletTips(c, lang) });
        }
      }
    }
    return out;
  }

  private bulletTips(c: LineCheck, lang: 'vi' | 'en'): string[] {
    const tips: string[] = [];
    if (c.weakOpener)
      tips.push(
        lang === 'vi'
          ? 'Mở đầu bằng động từ hành động mạnh thay vì cụm bị động/nhiệm vụ.'
          : 'Open with a strong action verb, not a duty/passive phrase.',
      );
    else if (!c.verbFirst)
      tips.push(
        lang === 'vi' ? 'Bắt đầu câu bằng một động từ hành động.' : 'Start with an action verb.',
      );
    if (!c.quantified)
      tips.push(
        lang === 'vi'
          ? 'Thêm số liệu/kết quả cụ thể (số, %, thời gian) nếu có.'
          : 'Add a concrete metric (number, %, time) where real.',
      );
    if (c.firstPerson)
      tips.push(
        lang === 'vi'
          ? "Bỏ ngôi thứ nhất ('tôi/em'); dùng chủ ngữ ngầm."
          : 'Drop first-person; use an implied subject.',
      );
    if (c.fillerCount > 0)
      tips.push(
        lang === 'vi' ? 'Bỏ từ sáo rỗng/buzzword.' : 'Remove filler/buzzwords.',
      );
    return tips;
  }

  private harvestBullets(doc: CanonicalCvDocument): string[] {
    const out: string[] = [];
    for (const e of doc.experience ?? []) out.push(...(e.bullets ?? []));
    for (const p of doc.projects ?? []) out.push(...(p.bullets ?? []));
    for (const a of doc.activities ?? []) out.push(...(a.bullets ?? []));
    return out.filter((b) => typeof b === 'string' && b.trim().length > 0);
  }

  /**
   * First k words, each trimmed of leading/trailing punctuation ("Designed," → "designed").
   * A leading enumerator/list marker ("1.", "(2)", "a)") is stripped first so it does not
   * masquerade as word 1 and hide an otherwise verb-first bullet ("1. Led…").
   */
  private firstWords(lower: string, k: number): string {
    const cleaned = lower.replace(/^\s*(?:\(?\d{1,3}[.)\]]|[a-zđ][.)\]])\s+/u, '');
    return cleaned
      .split(/\s+/)
      .map((w) => w.replace(/^[^\p{L}\d]+|[^\p{L}\d]+$/gu, ''))
      .filter((w) => w.length > 0)
      .slice(0, k)
      .join(' ');
  }

  private isWeakOpener(lower: string): boolean {
    const head = this.firstWords(lower, 3);
    return [...WEAK_OPENERS_EN, ...WEAK_OPENERS_VI].some(
      (w) => head === w || head.startsWith(`${w} `),
    );
  }

  private isVerbFirst(lower: string): boolean {
    const w1 = this.firstWords(lower, 1);
    const w2 = this.firstWords(lower, 2);
    const w3 = this.firstWords(lower, 3);
    // EN verbs are single words (w1) — matched directly OR via lemma so gerund / present-
    // participle / past forms also count ("Building"→build, "Leading"→lead, "Migrating"→migrate).
    // VI verbs are 1-3 words ("tối ưu", "tái cấu trúc").
    return (
      isStrongEnVerb(w1) ||
      STRONG_VERBS_VI.has(w1) ||
      STRONG_VERBS_VI.has(w2) ||
      STRONG_VERBS_VI.has(w3)
    );
  }

  private isQuantified(text: string): boolean {
    if (QUANT.test(text)) return true;
    // A bare number only counts as impact when the bullet also shows a result/impact cue.
    const nums = (text.match(BARE_NUMBER) ?? []).filter((nstr) => !YEAR.test(nstr));
    return nums.length > 0 && (IMPACT_CUE.test(text) || IMPACT_CUE_VI.test(text));
  }

  private countFiller(lower: string): number {
    let c = 0;
    for (const f of [...FILLER_EN, ...FILLER_VI]) if (lower.includes(f)) c += 1;
    return c;
  }

  /**
   * 0-20. Verb-first ratio is primary (strong active language); quantification is a
   * bonus capped so a metric-light but concrete CV is not auto-failed (~50% target,
   * not mandatory per the sourced methodology).
   */
  private score(verbFirstRatio: number, quantifiedRatio: number): number {
    let base: number;
    if (verbFirstRatio >= 0.8) base = 15;
    else if (verbFirstRatio >= 0.5) base = 11;
    else if (verbFirstRatio >= 0.25) base = 7;
    else base = 3;

    // Bonus aligned with the sourced methodology + the LLM rubric band it sits beside:
    // the exemplary band (18-20) requires ~50% quantified, so only q≥0.5 adds the full bonus.
    // A concrete-but-unquantified strong-verb CV is NOT down-scored below 'accomplished'.
    let bonus: number;
    if (quantifiedRatio >= 0.5) bonus = 5;
    else if (quantifiedRatio >= 0.25) bonus = 2;
    else if (quantifiedRatio > 0) bonus = 1;
    else bonus = 0;

    return Math.min(20, Math.max(0, base + bonus));
  }

  private notes(
    verbFirstRatio: number,
    quantifiedRatio: number,
    weakOpenerRatio: number,
    firstPersonRatio: number,
    filler: number,
  ): string[] {
    const notes: string[] = [];
    if (verbFirstRatio < 0.5) notes.push('Many bullets do not start with a strong action verb.');
    if (quantifiedRatio < 0.5)
      notes.push('Fewer than ~50% of bullets are quantified (add numbers/%/impact where real).');
    if (weakOpenerRatio > 0)
      notes.push('Some bullets open with weak duty phrases ("Responsible for…").');
    if (firstPersonRatio > 0)
      notes.push('Bullets use first-person ("I"/"tôi"); prefer implied subject.');
    if (filler > 0) notes.push(`${filler} filler/buzzword phrase(s) detected.`);
    return notes;
  }
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function toBand(score: number): BulletBand {
  if (score >= 18) return 'exemplary';
  if (score >= 13) return 'accomplished';
  if (score >= 7) return 'developing';
  return 'beginning';
}

/**
 * Lemma-normalize an English word so gerund / present-participle / past forms collapse to one
 * key. This lets a strong-verb set written in base+past forms ALSO match the "-ing"/"-ed"
 * variants ("building"→build, "migrating"→migrat≡migrated, "optimizing"→optimiz≡optimized) —
 * gerund-led bullets are a mainstream resume style and must not score as non-verb-first.
 */
function enLemma(w: string): string {
  if (w.length > 5 && w.endsWith('ing')) {
    const s = w.slice(0, -3);
    return /(.)\1$/.test(s) ? s.slice(0, -1) : s; // running→run, shipping→ship
  }
  if (w.length > 4 && w.endsWith('ied')) return `${w.slice(0, -3)}y`; // studied→study
  if (w.length > 4 && w.endsWith('ed')) {
    const s = w.slice(0, -2);
    return /(.)\1$/.test(s) ? s.slice(0, -1) : s; // optimized→optimiz, planned→plan
  }
  return w;
}
/** Lemma index of the strong-verb set, built once at module load. */
const STRONG_LEMMAS_EN = new Set([...STRONG_VERBS_EN].map(enLemma));
/** A word is a strong EN verb if it matches the set directly OR shares a lemma with it. */
function isStrongEnVerb(w: string): boolean {
  if (!w) return false;
  return STRONG_VERBS_EN.has(w) || STRONG_LEMMAS_EN.has(enLemma(w));
}

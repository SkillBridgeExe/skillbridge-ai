import { CanonicalCvDocument } from '../../common/types/canonical-cv';
import { classifyDegree, DEGREE_RANK, DegreeLevel } from '../../common/services/cv-profile-signals';

/**
 * Routed-Evidence Dimension-4 (Education, 0-20). Same pattern as Dim-1/Dim-2/Dim-3 (see
 * cv-review.service.ts routeDimension1/2/3): school presence, degree level, field-of-study and
 * GPA are MECHANICAL facts already sitting in the parsed document — scored deterministically
 * instead of trusting the LLM's own read. Education is the last LLM-owned dimension.
 *
 * Returns `null` only when `document.education` is empty AND the raw CV text still contains an
 * education keyword — that combination means the parser likely DROPPED a real education section,
 * so the caller keeps the LLM's own estimate rather than punish a CV that actually has one.
 */

/** Honest floor for a CV with no education entries at all (not "we don't know" — a real signal). */
const ZERO_EDUCATION_SCORE = 4;

const SCHOOL_BASE_POINTS = 8;
const BACHELOR_PLUS_BONUS = 6;
const ASSOCIATE_BONUS = 4;
const STUDYING_BONUS = 4;
const IT_FIELD_BONUS = 4;
const GPA_BONUS = 2;
const CAP = 20;

/** Parser-miss guard: an empty education[] with one of these tokens in the raw text likely means
 *  the parser dropped a real section — score deterministically to 4 ONLY when absent. */
const EDU_TOKEN_RE =
  /đại học|dai hoc|cao đẳng|cao dang|university|college|bachelor|b\.?s\.?|cử nhân|cu nhan|kỹ sư|ky su|tốt nghiệp|tot nghiep/i;

/** IT-relatedness of a field-of-study string. `classifyDegree` answers "does this text contain
 *  degree vocabulary" (e.g. "kỹ sư" = engineer, "thạc sĩ" = master) — NOT "is this IT" (a
 *  mechanical engineer or a finance master both contain degree words but aren't IT). So this is a
 *  keyword-only check against the actual IT/CS/SE/CNTT spellings (accented + unaccented). */
const IT_FIELD_RE =
  /\b(cs|se|it)\b|cntt|công nghệ thông tin|cong nghe thong tin|khoa học máy tính|khoa hoc may tinh|computer science|information technology|\bcomputer\b|\bsoftware\b|phần mềm|phan mem/iu;

/** First numeric token in a free-text GPA string, e.g. "8.2" → 8.2. Used only when no explicit
 *  "<num>/<den>" fraction is present (see GPA_FRAC_RE). */
const GPA_NUM_RE = /(\d+(?:[.,]\d+)?)/;

/** Explicit "<num>/<den>" fraction, e.g. "3.8/10" → num=3.8, den=10. Comma-decimal numerator is
 *  supported ("8,5/10"). */
const GPA_FRAC_RE = /(\d+(?:[.,]\d+)?)\s*\/\s*(\d+(?:[.,]\d+)?)/;

export type EducationScoreConfidence = 'high' | 'medium' | 'low';

export interface EducationScoreResult {
  score20: number;
  confidence: EducationScoreConfidence;
  evidence: string[];
  rationale_vi: string;
  rationale_en: string;
}

function isItField(field: string | null): boolean {
  if (!field?.trim()) return false;
  return IT_FIELD_RE.test(field);
}

/** GPA bonus is granted at >=3.0 on a /4 scale or >=7.5 on a /10 scale. When the string carries an
 *  explicit "<num>/<den>" denominator, that denominator picks the scale (4 or 10); any other/absent
 *  denominator falls back to the magnitude heuristic (<=4 → /4, else /10). Anything unparseable
 *  (missing, non-numeric, or off both scales) yields no bonus and never throws. */
function gpaBonusEligible(gpa: string | null): boolean {
  if (!gpa) return false;
  const frac = GPA_FRAC_RE.exec(gpa);
  if (frac) {
    const num = parseFloat(frac[1].replace(',', '.'));
    const den = parseFloat(frac[2].replace(',', '.'));
    if (Number.isNaN(num) || Number.isNaN(den)) return false;
    if (den === 4) return num >= 3.0;
    if (den === 10) return num >= 7.5;
    if (num <= 4) return num >= 3.0;
    if (num <= 10) return num >= 7.5;
    return false;
  }
  const m = GPA_NUM_RE.exec(gpa);
  if (!m) return false;
  const num = parseFloat(m[1].replace(',', '.'));
  if (Number.isNaN(num)) return false;
  if (num <= 4) return num >= 3.0;
  if (num <= 10) return num >= 7.5;
  return false;
}

/** The degree bonus is mutually exclusive by construction: bachelor+ requires a classified degree
 *  text; associate requires the same but at that level; "studying" requires NO degree text at all
 *  (so it can never also satisfy the other two). Unclassifiable degree text (e.g. below associate,
 *  or a degree title that doesn't match any pattern) earns no bonus. */
function degreeBonus(
  school: string | null,
  field: string | null,
  degree: string | null,
): { bonus: number; level: DegreeLevel | null } {
  const level = degree ? classifyDegree(degree) : null;
  if (level && DEGREE_RANK[level] >= DEGREE_RANK.bachelor)
    return { bonus: BACHELOR_PLUS_BONUS, level };
  if (level === 'associate') return { bonus: ASSOCIATE_BONUS, level };
  if (!degree && school?.trim() && field?.trim()) return { bonus: STUDYING_BONUS, level: null };
  return { bonus: 0, level };
}

interface EntryScore {
  score: number;
  level: DegreeLevel | null;
  itField: boolean;
  gpaOk: boolean;
}

/** Score a single entry, or `null` when it has no school name (not a real entry). */
function scoreEntry(entry: CanonicalCvDocument['education'][number]): EntryScore | null {
  if (!entry.school?.trim()) return null;
  const { bonus, level } = degreeBonus(entry.school, entry.field, entry.degree);
  const itField = isItField(entry.field);
  const gpaOk = gpaBonusEligible(entry.gpa);
  const score = Math.min(
    SCHOOL_BASE_POINTS + bonus + (itField ? IT_FIELD_BONUS : 0) + (gpaOk ? GPA_BONUS : 0),
    CAP,
  );
  return { score, level, itField, gpaOk };
}

export function scoreEducation(
  document: CanonicalCvDocument,
  rawText: string,
): EducationScoreResult | null {
  const entries = document.education ?? [];

  if (entries.length === 0) {
    if (EDU_TOKEN_RE.test(rawText ?? '')) return null; // parser likely dropped a real section
    return {
      score20: ZERO_EDUCATION_SCORE,
      confidence: 'high',
      evidence: ['0 education entries'],
      rationale_vi: 'CV chưa có mục học vấn (0 education entries).',
      rationale_en: 'No education entries found in the CV (0 education entries).',
    };
  }

  const scored = entries.map(scoreEntry).filter((s): s is EntryScore => s !== null);
  if (scored.length === 0) {
    // Entries exist but none carry a school name — same honest floor as "no entries".
    return {
      score20: ZERO_EDUCATION_SCORE,
      confidence: 'high',
      evidence: ['0 education entries with a school name'],
      rationale_vi: 'CV chưa có mục học vấn hợp lệ (thiếu tên trường).',
      rationale_en: 'No valid education entries (missing school name).',
    };
  }

  // Multiple entries: the BEST one (max points) owns the score — a strong bachelor's degree
  // should not be dragged down by an earlier high-school entry also present in the CV.
  const best = scored.reduce((a, b) => (b.score > a.score ? b : a));

  const evidence = [
    `${entries.length} education entries`,
    `best entry score=${best.score}/20`,
    ...(best.level ? [`degree=${best.level}`] : []),
    ...(best.itField ? ['field=IT-related'] : []),
    ...(best.gpaOk ? ['gpa bonus applied'] : []),
  ];

  return {
    score20: best.score,
    confidence: 'high',
    evidence,
    rationale_vi:
      `${entries.length} mục học vấn, mục điểm cao nhất đạt ${best.score}/20` +
      `${best.level ? ` (bằng cấp ${best.level})` : ''}${best.itField ? ', ngành liên quan CNTT' : ''}` +
      `${best.gpaOk ? ', GPA đạt tiêu chuẩn' : ''} (phân tích xác định).`,
    rationale_en:
      `${entries.length} education entries, best entry scores ${best.score}/20` +
      `${best.level ? ` (degree: ${best.level})` : ''}${best.itField ? ', IT-related field' : ''}` +
      `${best.gpaOk ? ', GPA meets threshold' : ''} (deterministic analysis).`,
  };
}

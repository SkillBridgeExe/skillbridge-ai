import { Injectable } from '@nestjs/common';
import { CanonicalCvDocument } from '../../common/types/canonical-cv';

export type RuleStatus = 'pass' | 'fail' | 'warn';

export interface RuleResult {
  rule_id: string;
  label: string;
  status: RuleStatus;
  /** 1 if pass, 0.5 if warn, 0 if fail */
  score: number;
  /** Optional human-readable hint (only on warn/fail) */
  hint?: string;
  /** Optional evidence quoted from CV */
  evidence?: string;
}

export interface AtsCheckResult {
  /** Overall ATS readability score 0-100, deterministic (no LLM). */
  ats_rule_score: number;
  rules: RuleResult[];
  /** Quick summary count of passed / total rules */
  summary: {
    total: number;
    passed: number;
    warned: number;
    failed: number;
  };
}

export interface AtsCheckInput {
  /**
   * Structured CV (from CvParserService). Section/contact/date checks run on
   * this — far more reliable than keyword-searching raw text.
   */
  document: CanonicalCvDocument;
  /** Raw extracted text — still needed for length + filler-phrase checks. */
  parsed_text: string;
  /** Optional MIME type hint, e.g. "application/pdf". */
  mime_type?: string;
  /** Optional: was the PDF/DOCX parsed as image-only (OCR mode)? */
  is_ocr_only?: boolean;
  /**
   * Optional: hint text language (the review's feedback locale). Same shape as
   * `analyzeBullets(document, feedbackLang?: string)` — takes plain `string` since the caller's
   * `feedbackLang` is `input.lang ?? document.language` (ISO 639-1, not guaranteed vi/en); narrowed
   * to 'vi' | 'en' internally. Defaults to the CV's own document.language when omitted.
   */
  lang?: string;
}

/** Picks the hint string for the given language — vi/en text stay side by side at the call site. */
type HintFn = (vi: string, en: string) => string;

const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
// VN mobile (03/05/07/08/09 or +84) + international fallback.
const PHONE_REGEX =
  /(\+?84|0)\s?(\d[\s.-]?){8,10}|\+?\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}/;

/**
 * Deterministic, rule-based ATS readability check — v2 (structured input).
 *
 * Now runs section/contact/date checks against the parsed CanonicalCvDocument
 * instead of keyword-searching raw text. Examples of the accuracy gain:
 *   - "has experience" = `document.experience.length > 0` (not "does the word
 *     'experience' appear" — which false-passes on a Skills line mentioning it).
 *   - "email present" = `document.contact.email` extracted (falls back to regex).
 *   - "dates present" = count of entries with start/end (not regex guesses).
 *
 * Length + filler-phrase checks still use raw text (word count, bullet phrasing).
 *
 * 10 rules, each contributes equally. pass=1, warn=0.5, fail=0.
 * ats_rule_score = sum / total * 100. PURE function — same input → same score.
 */
@Injectable()
export class AtsRuleCheckerService {
  check(input: AtsCheckInput): AtsCheckResult {
    const doc = input.document;
    const text = input.parsed_text ?? '';
    const wordCount = countWords(text);
    const lang: 'vi' | 'en' = (input.lang ?? doc.language) === 'vi' ? 'vi' : 'en';
    const h: HintFn = (vi, en) => (lang === 'vi' ? vi : en);

    const rules: RuleResult[] = [
      this.ruleFileFormatAcceptable(input, h),
      this.ruleHasContact(doc, text, h),
      this.ruleHasEducation(doc, h),
      this.ruleHasExperienceOrProjects(doc, h),
      this.ruleHasSkills(doc, h),
      this.ruleEmailPresent(doc, text, h),
      this.rulePhonePresent(doc, text, h),
      this.ruleReasonableLength(wordCount, h),
      this.ruleDatesPresent(doc, h),
      this.ruleNoExcessiveRepetition(doc, text, h),
    ];

    const passed = rules.filter((r) => r.status === 'pass').length;
    const warned = rules.filter((r) => r.status === 'warn').length;
    const failed = rules.filter((r) => r.status === 'fail').length;

    const total = rules.length;
    const totalScore = rules.reduce((s, r) => s + r.score, 0);
    const ats_rule_score = Math.round((totalScore / total) * 100);

    return { ats_rule_score, rules, summary: { total, passed, warned, failed } };
  }

  // ─── Rules ──────────────────────────────────────────────────────────────

  private ruleFileFormatAcceptable(input: AtsCheckInput, h: HintFn): RuleResult {
    const id = 'file_format_acceptable';
    if (input.is_ocr_only) {
      return {
        rule_id: id,
        label: 'CV không phải image-only (ATS đọc được text)',
        status: 'fail',
        score: 0,
        hint: h(
          'CV được parse dưới dạng OCR (CV ảnh). ATS không đọc được. Hãy export bản text từ Word/Google Docs.',
          'CV was parsed as OCR (image-based). ATS cannot read it. Export a text version from Word/Google Docs.',
        ),
      };
    }
    const mt = (input.mime_type ?? '').toLowerCase();
    if (
      mt &&
      mt !== 'application/pdf' &&
      !mt.includes('wordprocessingml') &&
      !mt.includes('msword') &&
      mt !== 'text/plain'
    ) {
      return {
        rule_id: id,
        label: 'CV file format hợp lệ (PDF/DOCX)',
        status: 'warn',
        score: 0.5,
        hint: h(
          `Định dạng "${mt}" có thể không được ATS hỗ trợ. Khuyến nghị PDF hoặc DOCX.`,
          `Format "${mt}" may not be supported by ATS. PDF or DOCX is recommended.`,
        ),
      };
    }
    return { rule_id: id, label: 'CV file format hợp lệ (PDF/DOCX)', status: 'pass', score: 1 };
  }

  private ruleHasContact(doc: CanonicalCvDocument, text: string, h: HintFn): RuleResult {
    const id = 'has_section_contact';
    const c = doc.contact;
    const hasName = !!c.name;
    const hasReach = !!(c.email || c.phone) || EMAIL_REGEX.test(text) || PHONE_REGEX.test(text);
    if (hasName && hasReach) {
      return {
        rule_id: id,
        label: 'Có thông tin liên hệ (tên + email/SĐT)',
        status: 'pass',
        score: 1,
      };
    }
    if (hasReach) {
      return {
        rule_id: id,
        label: 'Có thông tin liên hệ (tên + email/SĐT)',
        status: 'warn',
        score: 0.5,
        hint: h(
          'Thiếu tên rõ ràng ở đầu CV. Đặt họ tên đầy đủ ở dòng đầu tiên.',
          'Missing a clear name at the top of the CV. Put your full name on the first line.',
        ),
      };
    }
    return {
      rule_id: id,
      label: 'Có thông tin liên hệ (tên + email/SĐT)',
      status: 'fail',
      score: 0,
      hint: h(
        'Thiếu phần liên hệ. Thêm họ tên + email + số điện thoại ở đầu CV.',
        'Missing a contact section. Add full name + email + phone number at the top of the CV.',
      ),
    };
  }

  private ruleHasEducation(doc: CanonicalCvDocument, h: HintFn): RuleResult {
    const id = 'has_section_education';
    if (doc.education.length > 0) {
      return { rule_id: id, label: 'Có phần Học vấn', status: 'pass', score: 1 };
    }
    return {
      rule_id: id,
      label: 'Có phần Học vấn',
      status: 'fail',
      score: 0,
      hint: h(
        'Thiếu phần Học vấn. Thêm trường, ngành, thời gian, GPA (nếu tốt).',
        'Missing an Education section. Add school, major, dates, and GPA (if strong).',
      ),
    };
  }

  /** Lenient for students: experience OR projects counts (projects show capability). */
  private ruleHasExperienceOrProjects(doc: CanonicalCvDocument, h: HintFn): RuleResult {
    const id = 'has_section_experience';
    if (doc.experience.length > 0) {
      return { rule_id: id, label: 'Có Kinh nghiệm / Dự án', status: 'pass', score: 1 };
    }
    if (doc.projects.length > 0) {
      return {
        rule_id: id,
        label: 'Có Kinh nghiệm / Dự án',
        status: 'warn',
        score: 0.5,
        hint: h(
          'Chưa có kinh nghiệm làm việc nhưng có dự án — tốt cho SV. Cân nhắc thêm thực tập/CLB nếu có.',
          'No work experience yet but you have projects — good for a student. Consider adding an internship/club if you have one.',
        ),
      };
    }
    return {
      rule_id: id,
      label: 'Có Kinh nghiệm / Dự án',
      status: 'fail',
      score: 0,
      hint: h(
        'Thiếu cả Kinh nghiệm lẫn Dự án. Thêm ít nhất 1-2 dự án học tập/cá nhân với mô tả kết quả.',
        'Missing both Experience and Projects. Add at least 1-2 academic/personal projects with a description of the results.',
      ),
    };
  }

  private ruleHasSkills(doc: CanonicalCvDocument, h: HintFn): RuleResult {
    const id = 'has_section_skills';
    const s = doc.skills;
    const total = s.technical.length + s.soft.length + s.tools.length + s.languages.length;
    if (total >= 3) {
      return { rule_id: id, label: 'Có phần Kỹ năng', status: 'pass', score: 1 };
    }
    if (total > 0) {
      return {
        rule_id: id,
        label: 'Có phần Kỹ năng',
        status: 'warn',
        score: 0.5,
        hint: h(
          `Chỉ liệt kê ${total} kỹ năng — quá ít. Bổ sung kỹ năng chuyên môn + công cụ liên quan đến vị trí.`,
          `Only ${total} skill(s) listed — too few. Add technical skills + tools relevant to the role.`,
        ),
      };
    }
    return {
      rule_id: id,
      label: 'Có phần Kỹ năng',
      status: 'fail',
      score: 0,
      hint: h(
        'Thiếu phần Kỹ năng. Thêm danh sách kỹ năng kỹ thuật + công cụ.',
        'Missing a Skills section. Add a list of technical skills + tools.',
      ),
    };
  }

  private ruleEmailPresent(doc: CanonicalCvDocument, text: string, h: HintFn): RuleResult {
    const id = 'email_present';
    const email = doc.contact.email ?? text.match(EMAIL_REGEX)?.[0] ?? null;
    if (email) {
      return {
        rule_id: id,
        label: 'Có email liên hệ hợp lệ',
        status: 'pass',
        score: 1,
        evidence: email,
      };
    }
    return {
      rule_id: id,
      label: 'Có email liên hệ hợp lệ',
      status: 'fail',
      score: 0,
      hint: h(
        'Không tìm thấy email. Thêm email chuyên nghiệp (tránh nickname kiểu cute123@...).',
        'No email found. Add a professional email (avoid nicknames like cute123@...).',
      ),
    };
  }

  private rulePhonePresent(doc: CanonicalCvDocument, text: string, h: HintFn): RuleResult {
    const id = 'phone_present';
    const phone = doc.contact.phone ?? text.match(PHONE_REGEX)?.[0] ?? null;
    if (phone) {
      return { rule_id: id, label: 'Có số điện thoại', status: 'pass', score: 1, evidence: phone };
    }
    return {
      rule_id: id,
      label: 'Có số điện thoại',
      status: 'fail',
      score: 0,
      hint: h(
        'Không tìm thấy số điện thoại. Thêm format: 0xxx-xxx-xxx hoặc +84-xxx-xxx-xxx.',
        'No phone number found. Add one in the format: 0xxx-xxx-xxx or +84-xxx-xxx-xxx.',
      ),
    };
  }

  private ruleReasonableLength(wordCount: number, h: HintFn): RuleResult {
    const id = 'reasonable_length';
    const label = 'CV độ dài hợp lý (250-1500 từ)';
    if (wordCount < 100) {
      return {
        rule_id: id,
        label,
        status: 'fail',
        score: 0,
        hint: h(
          `CV chỉ có ${wordCount} từ — quá ngắn, không đủ thông tin để recruiter đánh giá.`,
          `CV has only ${wordCount} words — too short, not enough information for a recruiter to assess.`,
        ),
      };
    }
    if (wordCount < 250) {
      return {
        rule_id: id,
        label,
        status: 'warn',
        score: 0.5,
        hint: h(
          `CV chỉ ${wordCount} từ — nên bổ sung chi tiết về kinh nghiệm và dự án.`,
          `CV has only ${wordCount} words — add more detail about your experience and projects.`,
        ),
      };
    }
    if (wordCount > 1500) {
      return {
        rule_id: id,
        label,
        status: 'warn',
        score: 0.5,
        hint: h(
          `CV dài ${wordCount} từ — quá dài, recruiter chỉ đọc 6-10s. Cô đọng còn ~1 trang.`,
          `CV is ${wordCount} words — too long; recruiters skim 6-10s. Trim to ~1 page.`,
        ),
      };
    }
    return { rule_id: id, label, status: 'pass', score: 1 };
  }

  /** Count entries (education + experience + projects) that have any date. */
  private ruleDatesPresent(doc: CanonicalCvDocument, h: HintFn): RuleResult {
    const id = 'dates_present';
    const label = 'Có timeline rõ ràng (≥2 mốc thời gian)';
    let dated = 0;
    for (const e of doc.education) if (e.start || e.end) dated++;
    for (const e of doc.experience) if (e.start || e.end) dated++;
    // Student-lenient (consistent with ruleHasExperienceOrProjects, which treats projects as a
    // valid experience substitute): a real dated entry PLUS projects forms a credible timeline,
    // so a projects-heavy fresher CV is not unfairly capped. A CV with NO real date still warns,
    // and one with neither dates nor projects still fails.
    const hasProjects = doc.projects.length > 0;
    if (dated >= 2 || (dated >= 1 && hasProjects)) {
      return { rule_id: id, label, status: 'pass', score: 1 };
    }
    if (dated === 1 || hasProjects) {
      return {
        rule_id: id,
        label,
        status: 'warn',
        score: 0.5,
        hint: h(
          'Timeline còn mỏng. Mỗi vị trí/học vấn/dự án nên có mốc "MM/YYYY - MM/YYYY".',
          'Timeline is thin. Each position/education/project should have a "MM/YYYY - MM/YYYY" date range.',
        ),
      };
    }
    return {
      rule_id: id,
      label,
      status: 'fail',
      score: 0,
      hint: h(
        'Không có mốc thời gian. Mỗi mục cần "MM/YYYY - MM/YYYY" hoặc "YYYY - Hiện tại".',
        'No dates found. Each entry needs "MM/YYYY - MM/YYYY" or "YYYY - Present".',
      ),
    };
  }

  /** Filler phrases signal weak (non-action) bullets. Check bullets, fall back to full text. */
  private ruleNoExcessiveRepetition(doc: CanonicalCvDocument, text: string, h: HintFn): RuleResult {
    const id = 'no_excessive_repetition';
    const label = 'Không lạm dụng filler verbs (responsible for, tham gia, ...)';
    const fillers = [
      'responsible for',
      'helped with',
      'worked on',
      'in charge of',
      'duties included',
      'chịu trách nhiệm',
      'tham gia',
      'phụ trách',
    ];
    // Prefer bullets from structured doc; fall back to raw text.
    const bullets = [
      ...doc.experience.flatMap((e) => e.bullets),
      ...doc.projects.flatMap((p) => p.bullets),
      ...doc.activities.flatMap((a) => a.bullets),
    ];
    const haystack = (bullets.length > 0 ? bullets.join(' \n ') : text).toLowerCase();
    let fillerCount = 0;
    for (const f of fillers) fillerCount += haystack.split(f).length - 1;

    if (fillerCount <= 1) {
      return { rule_id: id, label, status: 'pass', score: 1 };
    }
    if (fillerCount <= 3) {
      return {
        rule_id: id,
        label,
        status: 'warn',
        score: 0.5,
        hint: h(
          `Phát hiện ${fillerCount} filler verbs. Thay bằng action verbs mạnh: "built", "led", "shipped", "tối ưu", "xây dựng".`,
          `Found ${fillerCount} filler verbs. Replace with strong action verbs: "built", "led", "shipped", "optimized".`,
        ),
      };
    }
    return {
      rule_id: id,
      label,
      status: 'fail',
      score: 0,
      hint: h(
        `Phát hiện ${fillerCount} filler verbs — CV nghe như mô tả công việc chứ không phải thành tựu. Rewrite với action verb + số liệu.`,
        `Found ${fillerCount} filler verbs — the CV reads like a job description, not accomplishments. Rewrite with action verbs + numbers.`,
      ),
    };
  }
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

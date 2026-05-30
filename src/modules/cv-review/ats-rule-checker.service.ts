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
}

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

    const rules: RuleResult[] = [
      this.ruleFileFormatAcceptable(input),
      this.ruleHasContact(doc, text),
      this.ruleHasEducation(doc),
      this.ruleHasExperienceOrProjects(doc),
      this.ruleHasSkills(doc),
      this.ruleEmailPresent(doc, text),
      this.rulePhonePresent(doc, text),
      this.ruleReasonableLength(wordCount),
      this.ruleDatesPresent(doc),
      this.ruleNoExcessiveRepetition(doc, text),
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

  private ruleFileFormatAcceptable(input: AtsCheckInput): RuleResult {
    const id = 'file_format_acceptable';
    if (input.is_ocr_only) {
      return {
        rule_id: id,
        label: 'CV không phải image-only (ATS đọc được text)',
        status: 'fail',
        score: 0,
        hint: 'CV được parse dưới dạng OCR (CV ảnh). ATS không đọc được. Hãy export bản text từ Word/Google Docs.',
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
        hint: `Định dạng "${mt}" có thể không được ATS hỗ trợ. Khuyến nghị PDF hoặc DOCX.`,
      };
    }
    return { rule_id: id, label: 'CV file format hợp lệ (PDF/DOCX)', status: 'pass', score: 1 };
  }

  private ruleHasContact(doc: CanonicalCvDocument, text: string): RuleResult {
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
        hint: 'Thiếu tên rõ ràng ở đầu CV. Đặt họ tên đầy đủ ở dòng đầu tiên.',
      };
    }
    return {
      rule_id: id,
      label: 'Có thông tin liên hệ (tên + email/SĐT)',
      status: 'fail',
      score: 0,
      hint: 'Thiếu phần liên hệ. Thêm họ tên + email + số điện thoại ở đầu CV.',
    };
  }

  private ruleHasEducation(doc: CanonicalCvDocument): RuleResult {
    const id = 'has_section_education';
    if (doc.education.length > 0) {
      return { rule_id: id, label: 'Có phần Học vấn', status: 'pass', score: 1 };
    }
    return {
      rule_id: id,
      label: 'Có phần Học vấn',
      status: 'fail',
      score: 0,
      hint: 'Thiếu phần Học vấn. Thêm trường, ngành, thời gian, GPA (nếu tốt).',
    };
  }

  /** Lenient for students: experience OR projects counts (projects show capability). */
  private ruleHasExperienceOrProjects(doc: CanonicalCvDocument): RuleResult {
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
        hint: 'Chưa có kinh nghiệm làm việc nhưng có dự án — tốt cho SV. Cân nhắc thêm thực tập/CLB nếu có.',
      };
    }
    return {
      rule_id: id,
      label: 'Có Kinh nghiệm / Dự án',
      status: 'fail',
      score: 0,
      hint: 'Thiếu cả Kinh nghiệm lẫn Dự án. Thêm ít nhất 1-2 dự án học tập/cá nhân với mô tả kết quả.',
    };
  }

  private ruleHasSkills(doc: CanonicalCvDocument): RuleResult {
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
        hint: `Chỉ liệt kê ${total} kỹ năng — quá ít. Bổ sung kỹ năng chuyên môn + công cụ liên quan đến vị trí.`,
      };
    }
    return {
      rule_id: id,
      label: 'Có phần Kỹ năng',
      status: 'fail',
      score: 0,
      hint: 'Thiếu phần Kỹ năng. Thêm danh sách kỹ năng kỹ thuật + công cụ.',
    };
  }

  private ruleEmailPresent(doc: CanonicalCvDocument, text: string): RuleResult {
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
      hint: 'Không tìm thấy email. Thêm email chuyên nghiệp (tránh nickname kiểu cute123@...).',
    };
  }

  private rulePhonePresent(doc: CanonicalCvDocument, text: string): RuleResult {
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
      hint: 'Không tìm thấy số điện thoại. Thêm format: 0xxx-xxx-xxx hoặc +84-xxx-xxx-xxx.',
    };
  }

  private ruleReasonableLength(wordCount: number): RuleResult {
    const id = 'reasonable_length';
    const label = 'CV độ dài hợp lý (250-1500 từ)';
    if (wordCount < 100) {
      return {
        rule_id: id,
        label,
        status: 'fail',
        score: 0,
        hint: `CV chỉ có ${wordCount} từ — quá ngắn, không đủ thông tin để recruiter đánh giá.`,
      };
    }
    if (wordCount < 250) {
      return {
        rule_id: id,
        label,
        status: 'warn',
        score: 0.5,
        hint: `CV chỉ ${wordCount} từ — nên bổ sung chi tiết về kinh nghiệm và dự án.`,
      };
    }
    if (wordCount > 1500) {
      return {
        rule_id: id,
        label,
        status: 'warn',
        score: 0.5,
        hint: `CV dài ${wordCount} từ — quá dài, recruiter chỉ đọc 6-10s. Cô đọng còn ~1 trang.`,
      };
    }
    return { rule_id: id, label, status: 'pass', score: 1 };
  }

  /** Count entries (education + experience + projects) that have any date. */
  private ruleDatesPresent(doc: CanonicalCvDocument): RuleResult {
    const id = 'dates_present';
    const label = 'Có timeline rõ ràng (≥2 mốc thời gian)';
    let dated = 0;
    for (const e of doc.education) if (e.start || e.end) dated++;
    for (const e of doc.experience) if (e.start || e.end) dated++;
    if (dated >= 2) {
      return { rule_id: id, label, status: 'pass', score: 1 };
    }
    if (dated === 1) {
      return {
        rule_id: id,
        label,
        status: 'warn',
        score: 0.5,
        hint: 'Chỉ 1 mục có mốc thời gian. Mỗi vị trí/học vấn cần start-end date rõ ràng.',
      };
    }
    return {
      rule_id: id,
      label,
      status: 'fail',
      score: 0,
      hint: 'Không có mốc thời gian. Mỗi mục cần "MM/YYYY - MM/YYYY" hoặc "YYYY - Hiện tại".',
    };
  }

  /** Filler phrases signal weak (non-action) bullets. Check bullets, fall back to full text. */
  private ruleNoExcessiveRepetition(doc: CanonicalCvDocument, text: string): RuleResult {
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
        hint: `Phát hiện ${fillerCount} filler verbs. Thay bằng action verbs mạnh: "built", "led", "shipped", "tối ưu", "xây dựng".`,
      };
    }
    return {
      rule_id: id,
      label,
      status: 'fail',
      score: 0,
      hint: `Phát hiện ${fillerCount} filler verbs — CV nghe như mô tả công việc chứ không phải thành tựu. Rewrite với action verb + số liệu.`,
    };
  }
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

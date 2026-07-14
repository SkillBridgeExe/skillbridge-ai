/**
 * CV Builder Assistant — read-only explanation mode (P3-3, PURE, no IO, no LLM).
 *
 * Answers "Why is this weak?" WITHOUT proposing a rewrite. The cited signals come
 * exclusively from the same deterministic gap analysis that drives Turn-1 questions
 * (analyzeBulletGaps / analyzeSummaryGaps), and the message is templated from those
 * signals — so the explanation can never claim a missing metric, employer, tech, or
 * JD requirement that the analysis did not actually detect. No patch, ever.
 */
import { CompanionContext, Language, analyzeBulletGaps, analyzeSummaryGaps } from './cv-assistant';

/** ats_readability is reserved for a future deterministic ATS signal — never emitted today. */
export type CitedSignal =
  | 'missing_action'
  | 'missing_role'
  | 'missing_tech'
  | 'missing_result'
  | 'weak_evidence'
  | 'ats_readability';

export interface AssistantExplanation {
  type: 'explanation';
  message: string;
  citedSignals: CitedSignal[];
}

const BULLET_SIGNAL: Record<'action' | 'tech' | 'result', CitedSignal> = {
  action: 'missing_action',
  tech: 'missing_tech',
  result: 'missing_result',
};

const SUMMARY_SIGNAL: Record<'role' | 'strength' | 'evidence', CitedSignal> = {
  role: 'missing_role',
  strength: 'missing_tech',
  evidence: 'weak_evidence',
};

const LEAD_WEAK: Record<Language, string> = {
  en: 'Here is why this reads weak to a recruiter:',
  vi: 'Đây là lý do mục này đọc chưa thuyết phục với nhà tuyển dụng:',
};

const SIGNAL_TEXT: Record<Language, Record<CitedSignal, string>> = {
  en: {
    missing_action: 'It does not show what YOU did — no clear action verb (built, led, optimized).',
    missing_role: 'It does not state the role you are aiming for.',
    missing_tech: 'It names no concrete technology or skill.',
    missing_result: 'It shows no measurable result or outcome.',
    weak_evidence: 'It gives no evidence — years of experience or a standout result.',
    ats_readability: 'Its phrasing is hard for an ATS to parse.',
  },
  vi: {
    missing_action: 'Chưa thấy BẠN đã làm gì — thiếu động từ hành động rõ (xây, dẫn dắt, tối ưu).',
    missing_role: 'Chưa nêu vị trí bạn đang hướng tới.',
    missing_tech: 'Chưa nêu công nghệ hay kỹ năng cụ thể nào.',
    missing_result: 'Chưa có kết quả hay tác động đo được.',
    weak_evidence: 'Chưa có bằng chứng — số năm kinh nghiệm hoặc một kết quả nổi bật.',
    ats_readability: 'Cách diễn đạt khó cho hệ thống ATS đọc.',
  },
};

const STRONG_BULLET: Record<Language, string> = {
  en: 'This bullet already reads strong — it shows an action, a concrete tech, and a result. Nothing to fix here.',
  vi: 'Mục này đã đọc tốt — có hành động, công nghệ cụ thể và kết quả. Không có gì phải sửa.',
};
const STRONG_SUMMARY: Record<Language, string> = {
  en: 'This summary already reads strong — it names a role, concrete strengths, and evidence. Nothing to fix here.',
  vi: 'Bản tóm tắt đã đọc tốt — có vị trí, thế mạnh cụ thể và bằng chứng. Không có gì phải sửa.',
};

function explanation(
  signals: CitedSignal[],
  strongMsg: string,
  lang: Language,
): AssistantExplanation {
  if (signals.length === 0) {
    return { type: 'explanation', message: strongMsg, citedSignals: [] };
  }
  const message = [LEAD_WEAK[lang], ...signals.map((s) => SIGNAL_TEXT[lang][s])].join(' ');
  return { type: 'explanation', message, citedSignals: signals };
}

/**
 * Route a CV-builder field to its read-only explanation. Same routing contract as
 * cvBuilderAssistantTurn1: summary → summary signals; projects/experience (or
 * unspecified) → bullet signals; other sections/empty value → null.
 */
export function buildCvAssistantExplanation(ctx: CompanionContext): AssistantExplanation | null {
  if (ctx.page !== 'cv_builder') return null;
  if (!ctx.current_value || ctx.current_value.trim().length === 0) return null;
  const lang = ctx.locale;
  if (ctx.section === 'summary') {
    const signals = analyzeSummaryGaps(ctx.current_value, lang).map((g) => SUMMARY_SIGNAL[g]);
    return explanation(signals, STRONG_SUMMARY[lang], lang);
  }
  if (!ctx.section || ctx.section === 'projects' || ctx.section === 'experience') {
    const signals = analyzeBulletGaps(ctx.current_value, lang).map((g) => BULLET_SIGNAL[g]);
    return explanation(signals, STRONG_BULLET[lang], lang);
  }
  return null;
}

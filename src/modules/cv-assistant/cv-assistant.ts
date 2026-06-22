/**
 * CV Builder Assistant v1 — deterministic core (Phase 1, first flow of the site-wide assistant vision).
 *
 * DEMONSTRATES THE APPROACH (deterministic-first):
 *   - NO LLM for detecting weakness or asking questions — that is cheap, reproducible, and CANNOT
 *     hallucinate. The LLM is only invoked LATER (next turn) to phrase the rewrite from the user's
 *     answers, never to invent facts.
 *   - Anti-fabrication: a turn never carries a `field_patch` until the user has answered; the assistant
 *     ASKS for missing facts instead of fabricating metrics/companies/achievements (vision §2 + §5).
 *   - Bilingual (vi/en) — the product requirement; questions/options follow the UI locale.
 * Grounds in the same signal concepts as the interview answer-analyzer (action verb / named tech /
 * quantified result); in the full build these helpers are shared, not duplicated.
 */

export type Language = 'vi' | 'en';
/** what a strong project/experience bullet needs but may be missing. */
export type BulletGap = 'action' | 'tech' | 'result';
/** what a strong professional summary needs but may be missing. */
export type SummaryGap = 'role' | 'strength' | 'evidence';
/** any gap the assistant can ask about — bullets + summary share the answer/grounding pipeline. */
export type AssistantGap = BulletGap | SummaryGap;

export interface AssistantOption {
  id: string;
  label: string;
}
export interface AssistantQuestion {
  gap: AssistantGap;
  prompt: string;
  options: AssistantOption[];
  /** whether the FE should also offer a free-text field (a category chip alone may not be enough). */
  allows_free_text: boolean;
}
export interface CvAssistantTurn {
  message: string;
  questions: AssistantQuestion[];
  /** true once the assistant has enough to PROPOSE a rewrite (after answers) — never before. */
  requires_user_confirmation: boolean;
  /** a rewrite patch is produced only AFTER the user answers (a later turn) — never fabricated here. */
  field_patch: null;
}

/**
 * Companion shell context — tells a skill WHERE the user is + WHAT real value is being edited, so the
 * assistant is context-aware (a mascot), not a free-floating utility. V1 routes only `page==='cv_builder'`
 * + a project/experience `section` → this skill.
 */
export interface CompanionContext {
  page: 'cv_builder' | 'diagnosis';
  section?: 'summary' | 'projects' | 'experience' | 'skills' | 'education';
  cv_id?: string;
  field_path?: string;
  current_value?: string;
  locale: Language;
}

/** one user answer to a Turn-1 question: a category chip + an optional concrete detail. */
export interface CvAnswer {
  gap: AssistantGap;
  option_id: string;
  /** free text OR a picked known-tech; REQUIRED for `tech` before a rewrite (a category alone is not enough). */
  detail?: string;
}

const ACTION_VERBS: Record<Language, string[]> = {
  en: [
    'built',
    'implemented',
    'created',
    'designed',
    'developed',
    'shipped',
    'deployed',
    'led',
    'optimized',
    'refactored',
    'migrated',
    'automated',
    'launched',
    'architected',
  ],
  vi: [
    'xây',
    'triển khai',
    'tạo',
    'thiết kế',
    'phát triển',
    'tối ưu',
    'tự động hoá',
    'dẫn dắt',
    'ra mắt',
    'chuyển đổi',
  ],
};

const RESULT_CUE: Record<Language, string[]> = {
  en: [
    'reduced',
    'increased',
    'cut',
    'saved',
    'improved',
    'grew',
    'doubled',
    'boosted',
    'decreased',
  ],
  vi: ['giảm', 'tăng', 'cải thiện', 'tiết kiệm', 'rút ngắn', 'gấp đôi'],
};

/** a number next to a unit/metric ("30%", "200ms", "10k users", "2 weeks"). */
const NUMBER_UNIT =
  /\b\d+(?:\.\d+)?\s?(?:%|ms|s|x|k|m|gb|mb|users?|requests?|reqs?|hours?|days?|weeks?|months?)\b/iu;

/** capitalized words that are NOT proper-noun tech signals. */
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
  'Em',
  'Tôi',
]);

function hasAny(lower: string, words: string[]): boolean {
  return words.some((w) => lower.includes(w));
}

/** a capitalized proper-noun-looking token NOT at sentence start (React, Node, Redis, PostgreSQL, API). */
function hasTechToken(bullet: string): boolean {
  const toks = bullet.split(/\s+/);
  for (let i = 1; i < toks.length; i++) {
    const raw = toks[i].replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (raw.length >= 2 && /^[A-Z][A-Za-z0-9.+#]*$/.test(raw) && !COMMON_CAPS.has(raw)) return true;
  }
  return false;
}

/** Deterministically detect which strong-bullet ingredients are missing. */
export function analyzeBulletGaps(bullet: string, language: Language): BulletGap[] {
  const lower = bullet.toLowerCase();
  const gaps: BulletGap[] = [];
  if (!hasAny(lower, ACTION_VERBS[language])) gaps.push('action');
  if (!hasTechToken(bullet)) gaps.push('tech');
  if (!NUMBER_UNIT.test(bullet) && !hasAny(lower, RESULT_CUE[language])) gaps.push('result');
  return gaps;
}

/** role nouns that signal a professional summary already states a target role. */
const ROLE_WORDS: Record<Language, string[]> = {
  en: [
    'developer',
    'engineer',
    'analyst',
    'designer',
    'manager',
    'specialist',
    'scientist',
    'architect',
    'administrator',
    'consultant',
    'tester',
    'marketer',
    'intern',
    'student',
  ],
  vi: [
    'lập trình',
    'kỹ sư',
    'phân tích',
    'thiết kế',
    'quản lý',
    'chuyên viên',
    'kiến trúc',
    'kiểm thử',
    'thực tập',
    'sinh viên',
  ],
};

/** a stated amount of experience, e.g. "2 years", "3+ năm". */
const YEARS_RE = /\b\d+\+?\s?(?:years?|năm)\b/iu;

/** Deterministically detect which professional-summary ingredients are missing. */
export function analyzeSummaryGaps(summary: string, language: Language): SummaryGap[] {
  const lower = summary.toLowerCase();
  const gaps: SummaryGap[] = [];
  if (!hasAny(lower, ROLE_WORDS[language])) gaps.push('role');
  if (!hasTechToken(summary)) gaps.push('strength');
  if (!NUMBER_UNIT.test(summary) && !YEARS_RE.test(summary)) gaps.push('evidence');
  return gaps;
}

const QUESTIONS: Record<
  Language,
  Record<BulletGap, Omit<AssistantQuestion, 'allows_free_text'>>
> = {
  en: {
    action: {
      gap: 'action',
      prompt: 'What exactly did YOU do here?',
      options: [
        { id: 'built', label: 'Built / implemented a feature' },
        { id: 'designed', label: 'Designed the system or UI' },
        { id: 'led', label: 'Led / coordinated the work' },
        { id: 'fixed', label: 'Fixed / improved something' },
        { id: 'other', label: 'Other' },
      ],
    },
    tech: {
      gap: 'tech',
      prompt: 'Which tools or technologies did you use?',
      options: [
        { id: 'frontend', label: 'Frontend (React, Vue, …)' },
        { id: 'backend', label: 'Backend (Node, Java, …)' },
        { id: 'data', label: 'Database / data' },
        { id: 'devops', label: 'Deploy / DevOps' },
        { id: 'none', label: 'No specific tech' },
      ],
    },
    result: {
      gap: 'result',
      prompt: 'Did it have a measurable result?',
      options: [
        { id: 'faster', label: 'Faster / lower latency' },
        { id: 'more_users', label: 'More users / usage' },
        { id: 'fewer_errors', label: 'Fewer errors / bugs' },
        { id: 'process', label: 'Better process' },
        { id: 'none', label: 'No metric' },
      ],
    },
  },
  vi: {
    action: {
      gap: 'action',
      prompt: 'Cụ thể BẠN đã làm gì ở đây?',
      options: [
        { id: 'built', label: 'Xây / hiện thực một tính năng' },
        { id: 'designed', label: 'Thiết kế hệ thống hoặc giao diện' },
        { id: 'led', label: 'Dẫn dắt / điều phối công việc' },
        { id: 'fixed', label: 'Sửa / cải thiện điều gì đó' },
        { id: 'other', label: 'Khác' },
      ],
    },
    tech: {
      gap: 'tech',
      prompt: 'Bạn dùng công cụ / công nghệ nào?',
      options: [
        { id: 'frontend', label: 'Frontend (React, Vue, …)' },
        { id: 'backend', label: 'Backend (Node, Java, …)' },
        { id: 'data', label: 'Cơ sở dữ liệu / data' },
        { id: 'devops', label: 'Triển khai / DevOps' },
        { id: 'none', label: 'Không có công nghệ cụ thể' },
      ],
    },
    result: {
      gap: 'result',
      prompt: 'Có kết quả đo được không?',
      options: [
        { id: 'faster', label: 'Nhanh hơn / giảm độ trễ' },
        { id: 'more_users', label: 'Nhiều người dùng hơn' },
        { id: 'fewer_errors', label: 'Ít lỗi hơn' },
        { id: 'process', label: 'Quy trình tốt hơn' },
        { id: 'none', label: 'Không có số liệu' },
      ],
    },
  },
};

const SUMMARY_QUESTIONS: Record<
  Language,
  Record<SummaryGap, Omit<AssistantQuestion, 'allows_free_text'>>
> = {
  en: {
    role: {
      gap: 'role',
      prompt: 'What role is this summary aimed at?',
      options: [
        { id: 'frontend', label: 'Frontend Developer' },
        { id: 'backend', label: 'Backend Developer' },
        { id: 'fullstack', label: 'Fullstack Developer' },
        { id: 'data', label: 'Data Analyst' },
        { id: 'other', label: 'Other (type it)' },
      ],
    },
    strength: {
      gap: 'strength',
      prompt: 'Your 2-3 strongest skills or technologies?',
      options: [
        { id: 'frontend', label: 'Frontend (React, Vue, …)' },
        { id: 'backend', label: 'Backend (Node, Java, …)' },
        { id: 'data', label: 'Data / ML' },
        { id: 'devops', label: 'DevOps / Cloud' },
        { id: 'other', label: 'Other (type them)' },
      ],
    },
    evidence: {
      gap: 'evidence',
      prompt: 'Years of experience or a standout result? (optional)',
      options: [
        { id: 'fresher', label: 'Fresher / student' },
        { id: '1_2y', label: '1-2 years' },
        { id: '3_5y', label: '3-5 years' },
        { id: '5y_plus', label: '5+ years' },
        { id: 'none', label: 'Skip' },
      ],
    },
  },
  vi: {
    role: {
      gap: 'role',
      prompt: 'Bản tóm tắt này hướng tới vị trí nào?',
      options: [
        { id: 'frontend', label: 'Lập trình Frontend' },
        { id: 'backend', label: 'Lập trình Backend' },
        { id: 'fullstack', label: 'Lập trình Fullstack' },
        { id: 'data', label: 'Phân tích dữ liệu' },
        { id: 'other', label: 'Khác (tự nhập)' },
      ],
    },
    strength: {
      gap: 'strength',
      prompt: '2-3 kỹ năng / công nghệ mạnh nhất của bạn?',
      options: [
        { id: 'frontend', label: 'Frontend (React, Vue, …)' },
        { id: 'backend', label: 'Backend (Node, Java, …)' },
        { id: 'data', label: 'Data / ML' },
        { id: 'devops', label: 'DevOps / Cloud' },
        { id: 'other', label: 'Khác (tự nhập)' },
      ],
    },
    evidence: {
      gap: 'evidence',
      prompt: 'Số năm kinh nghiệm hoặc một kết quả nổi bật? (không bắt buộc)',
      options: [
        { id: 'fresher', label: 'Mới ra trường / sinh viên' },
        { id: '1_2y', label: '1-2 năm' },
        { id: '3_5y', label: '3-5 năm' },
        { id: '5y_plus', label: '5+ năm' },
        { id: 'none', label: 'Bỏ qua' },
      ],
    },
  },
};

const STRONG_MSG: Record<Language, string> = {
  en: 'This bullet is already strong — it shows an action, a tech, and a result.',
  vi: 'Mục này đã đủ mạnh — có hành động, công nghệ và kết quả.',
};
const WEAK_MSG: Record<Language, string> = {
  en: 'This bullet can be stronger — answer a few questions and I will help rewrite it (I will NOT invent metrics, companies, or achievements).',
  vi: 'Mục này có thể mạnh hơn — trả lời vài câu để mình giúp viết lại (mình KHÔNG bịa số liệu, công ty hay thành tích).',
};

/** Build ONE deterministic assistant turn for a CV bullet: ask for the missing facts, never fabricate. */
export function buildCvAssistantTurn(bullet: string, language: Language): CvAssistantTurn {
  const gaps = analyzeBulletGaps(bullet, language);
  if (gaps.length === 0) {
    return {
      message: STRONG_MSG[language],
      questions: [],
      requires_user_confirmation: false,
      field_patch: null,
    };
  }
  return {
    message: WEAK_MSG[language],
    questions: gaps.map((g) => ({ ...QUESTIONS[language][g], allows_free_text: true })),
    requires_user_confirmation: false,
    field_patch: null,
  };
}

const SUMMARY_STRONG_MSG: Record<Language, string> = {
  en: 'This summary is already strong — it names a role, concrete strengths, and evidence.',
  vi: 'Bản tóm tắt đã đủ mạnh — có vị trí, thế mạnh cụ thể và bằng chứng.',
};
const SUMMARY_WEAK_MSG: Record<Language, string> = {
  en: 'This summary can be sharper — answer a few questions and I will rewrite it (I will NOT invent skills, titles, or numbers).',
  vi: 'Bản tóm tắt có thể sắc hơn — trả lời vài câu để mình viết lại (mình KHÔNG bịa kỹ năng, chức danh hay số liệu).',
};

/** Build ONE deterministic assistant turn for a professional summary: ask for missing facts, never fabricate. */
export function buildSummaryTurn(summary: string, language: Language): CvAssistantTurn {
  const gaps = analyzeSummaryGaps(summary, language);
  if (gaps.length === 0) {
    return {
      message: SUMMARY_STRONG_MSG[language],
      questions: [],
      requires_user_confirmation: false,
      field_patch: null,
    };
  }
  return {
    message: SUMMARY_WEAK_MSG[language],
    questions: gaps.map((g) => ({ ...SUMMARY_QUESTIONS[language][g], allows_free_text: true })),
    requires_user_confirmation: false,
    field_patch: null,
  };
}

/**
 * Companion shell entry: route a CV-builder section to Turn-1 on its current value.
 * `summary` → summary gaps; `projects`/`experience` (or unspecified) → bullet gaps; others → null.
 */
export function cvBuilderAssistantTurn1(ctx: CompanionContext): CvAssistantTurn | null {
  if (ctx.page !== 'cv_builder') return null;
  if (!ctx.current_value || ctx.current_value.trim().length === 0) return null;
  if (ctx.section === 'summary') return buildSummaryTurn(ctx.current_value, ctx.locale);
  if (!ctx.section || ctx.section === 'projects' || ctx.section === 'experience') {
    return buildCvAssistantTurn(ctx.current_value, ctx.locale);
  }
  return null;
}

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

export interface AssistantOption {
  id: string;
  label: string;
}
export interface AssistantQuestion {
  gap: BulletGap;
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
  gap: BulletGap;
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

/**
 * Companion shell entry: route a CV-builder project/experience section to Turn-1 on its current value.
 * Returns null when out of V1a scope (other page/section, or no value) — the shell shows nothing then.
 */
export function cvBuilderAssistantTurn1(ctx: CompanionContext): CvAssistantTurn | null {
  if (ctx.page !== 'cv_builder') return null;
  if (ctx.section && ctx.section !== 'projects' && ctx.section !== 'experience') return null;
  if (!ctx.current_value || ctx.current_value.trim().length === 0) return null;
  return buildCvAssistantTurn(ctx.current_value, ctx.locale);
}

import { AssistantGap, AssistantQuestion, Language } from './cv-assistant';

/** A standalone number in question prose/chips = a planted value (mồi user nói dối). Mirror of
 *  trends-insight's digitFree; digits inside tech names (K8s, ES6, Vue3) are not planted claims. */
const STANDALONE_NUMBER = /(?<![A-Za-z0-9])\d+(?:[.,]\d+)?(?![A-Za-z0-9])/;
export function hasPlantedNumber(text: string): boolean {
  return STANDALONE_NUMBER.test(text);
}

export interface RawSmartQuestion {
  gap: string;
  prompt: string;
  chips: string[];
}

/** Neutral fallback prompt per gap when the LLM prompt got stripped for a planted number. */
const SAFE_PROMPT: Record<Language, Record<string, string>> = {
  vi: {
    action: 'Cụ thể BẠN đã làm gì?',
    tech: 'Bạn dùng công nghệ nào?',
    result: 'Có kết quả đo được không?',
    role: 'Bạn nhắm vai trò nào?',
    strength: 'Thế mạnh của bạn là gì?',
    evidence: 'Bằng chứng cụ thể là gì?',
  },
  en: {
    action: 'What exactly did YOU do?',
    tech: 'Which tech did you use?',
    result: 'Any measurable result?',
    role: 'Which role are you targeting?',
    strength: 'What is your strength?',
    evidence: 'What concrete evidence?',
  },
};

export function groundSmartQuestions(
  raw: unknown,
  detectedGaps: AssistantGap[],
  language: Language,
): { questions: AssistantQuestion[]; already_strong: boolean } | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { already_strong?: unknown; questions?: unknown };
  const allowed = new Set<string>(detectedGaps);
  const list = Array.isArray(r.questions) ? r.questions : [];
  const out: AssistantQuestion[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const q = item as Partial<RawSmartQuestion>;
    if (typeof q?.gap !== 'string' || !allowed.has(q.gap) || seen.has(q.gap)) continue;
    seen.add(q.gap);
    const gap = q.gap as AssistantGap;
    const promptOk = typeof q.prompt === 'string' && q.prompt.trim() && !hasPlantedNumber(q.prompt);
    const prompt = promptOk ? q.prompt!.slice(0, 200) : SAFE_PROMPT[language][gap];
    const chips = (Array.isArray(q.chips) ? q.chips : [])
      .filter(
        (c): c is string => typeof c === 'string' && c.trim().length > 0 && !hasPlantedNumber(c),
      )
      .slice(0, 5)
      .map((label, i) => ({ id: `${gap}_${i}`, label: label.slice(0, 60) }));
    out.push({ gap, prompt, options: chips, allows_free_text: true });
  }
  if (out.length === 0) return null;
  return { questions: out, already_strong: r.already_strong === true };
}

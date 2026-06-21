import { InterviewFocusArea } from './interview-planner';

export type InterviewPhase =
  | 'SCREENING'
  | 'SKILL_PROBE'
  | 'JD_REQUIREMENT'
  | 'SCENARIO'
  | 'BEHAVIORAL'
  | 'WRAP';

export interface AgendaTopic {
  id: string;
  phase: InterviewPhase;
  skill_canonical: string | null;
  display_name: string;
  source: 'cv' | 'jd' | 'gap' | 'fixed';
  priority: number;
  seniority_target: string;
  drill_budget: number;
  what_to_probe: string;
  seed_question: string;
  cv_evidence_excerpt?: string;
  jd_requirement_text?: string;
}

export interface InterviewAgenda {
  topics: AgendaTopic[];
  turn_budget: number;
  uncovered: AgendaTopic[];
}

export const TURN_BUDGET_BY_TIER: Record<string, number> = { free: 6, paid: 10 };

const MAX_DRILL = 3;
const FOCUS_PRIORITY: Record<InterviewFocusArea['focus_type'], number> = {
  gap_probe: 4,
  evidence_probe: 3,
  depth_probe: 2,
  strength_showcase: 1,
};

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

export function buildInterviewAgenda(input: {
  focusAreas: InterviewFocusArea[];
  seniority: string;
  turnBudget: number;
}): InterviewAgenda {
  const turn_budget = Math.max(4, Math.floor(input.turnBudget));
  const includeExtras = turn_budget > 7;
  const reserved = includeExtras ? 4 : 2;

  const toTopic = (
    focus: InterviewFocusArea,
    priority: number,
    index: number,
    drillBudget: number,
  ): AgendaTopic => ({
    id: `topic-${index}-${slug(focus.skill_canonical ?? focus.display_name)}`,
    phase: focus.focus_type === 'strength_showcase' ? 'SKILL_PROBE' : 'JD_REQUIREMENT',
    skill_canonical: focus.skill_canonical ?? null,
    display_name: focus.display_name,
    source: focus.focus_type === 'strength_showcase' ? 'cv' : 'gap',
    priority,
    seniority_target: input.seniority,
    drill_budget: drillBudget,
    what_to_probe: focus.reason,
    seed_question: focus.template_question,
  });

  const ranked = input.focusAreas
    .map((focus, index) => ({ focus, priority: FOCUS_PRIORITY[focus.focus_type], index }))
    .sort((a, b) => b.priority - a.priority || a.index - b.index);

  const pool = Math.max(0, turn_budget - reserved);
  const kept: AgendaTopic[] = [];
  const uncovered: AgendaTopic[] = [];
  let remaining = pool;

  for (const item of ranked) {
    if (remaining <= 0) {
      uncovered.push(toTopic(item.focus, item.priority, item.index, 1));
      continue;
    }
    const budget = Math.min(MAX_DRILL, remaining);
    kept.push(toTopic(item.focus, item.priority, item.index, budget));
    remaining -= budget;
  }

  const topics: AgendaTopic[] = [
    {
      id: 'screening-1',
      phase: 'SCREENING',
      skill_canonical: null,
      display_name: 'Motivation & most recent work',
      source: 'fixed',
      priority: 0,
      seniority_target: input.seniority,
      drill_budget: 1,
      what_to_probe: 'warm-up; motivation and most recent real work',
      seed_question:
        'To start, what have you been working on recently, and what drew you to this role?',
    },
    ...kept,
  ];

  if (includeExtras && kept.length > 0) {
    const top = kept[0];
    topics.push({
      id: 'scenario-1',
      phase: 'SCENARIO',
      skill_canonical: top.skill_canonical,
      display_name: `Scenario: ${top.display_name}`,
      source: 'gap',
      priority: top.priority,
      seniority_target: input.seniority,
      drill_budget: 1,
      what_to_probe: `applied reasoning on ${top.display_name}`,
      seed_question: `Let's make it concrete around ${top.display_name}: walk me through how you would approach it on a real task.`,
    });
  }

  if (includeExtras) {
    topics.push({
      id: 'behavioral-1',
      phase: 'BEHAVIORAL',
      skill_canonical: null,
      display_name: 'Behavioral (STAR)',
      source: 'fixed',
      priority: 0,
      seniority_target: input.seniority,
      drill_budget: 1,
      what_to_probe: 'ownership, collaboration, and handling difficulty with STAR structure',
      seed_question: 'Tell me about a time a project did not go as planned. What happened?',
    });
  }

  topics.push({
    id: 'wrap-1',
    phase: 'WRAP',
    skill_canonical: null,
    display_name: 'Wrap-up',
    source: 'fixed',
    priority: 0,
    seniority_target: input.seniority,
    drill_budget: 1,
    what_to_probe: 'graceful close and candidate questions',
    seed_question: "We're almost out of time. Anything you would like to add, or questions for me?",
  });

  return { topics, turn_budget, uncovered };
}

export type DepthSignal = 'shallow' | 'adequate' | 'deep' | 'evasive';
export type TurnAction = 'drill' | 'push_harder' | 'advance' | 'wrap';

export interface InterviewState {
  current_phase: InterviewPhase;
  current_topic_id: string;
  drill_depth: number;
  current_thread: string;
  running_notes: string[];
  covered_topic_ids: string[];
  uncovered_topic_ids: string[];
  turns_used: number;
  evasive_streak: number;
}

/**
 * Early-career seniority bands. SINGLE SOURCE OF TRUTH shared with interview-scoring's role-family
 * resolution: a band drilled lighter here (decideTurn) MUST also be scored on the low-evidence
 * fresher_intern rubric column — exporting one set keeps drill + score from drifting (review P1-1).
 */
export const EARLY_CAREER_BANDS: ReadonlySet<string> = new Set([
  'fresher',
  'intern',
  'junior',
  'entry_level',
]);

export function decideTurn(input: {
  signal: DepthSignal;
  drill_depth: number;
  drill_budget: number;
  turns_used: number;
  turn_budget: number;
  evasive_streak: number;
  seniority_target: string;
}): TurnAction {
  if (input.turns_used >= input.turn_budget - 1) return 'wrap';
  if (input.turns_used >= input.turn_budget - 2 && input.drill_depth === 0) return 'wrap';
  if (input.evasive_streak >= 2 || (input.signal === 'evasive' && input.drill_depth >= 1)) {
    return 'advance';
  }
  if (input.drill_depth >= input.drill_budget - 1) return 'advance';
  if (input.signal === 'deep') {
    const fresher = EARLY_CAREER_BANDS.has(input.seniority_target.trim().toLowerCase());
    const pastHalf = input.drill_depth >= Math.ceil(input.drill_budget / 2);
    return fresher || pastHalf ? 'advance' : 'push_harder';
  }
  return 'drill';
}

export function filterRecognizedConcepts(
  concepts: string[],
  answerText: string,
  aliases: Record<string, string[]> = {},
): string[] {
  const answerTokens = tokenizeConcept(answerText);
  const present = (term: string): boolean => {
    const termTokens = tokenizeConcept(term);
    if (termTokens.length === 0 || termTokens.length > answerTokens.length) return false;
    return answerTokens.some((_, index) =>
      termTokens.every((token, offset) => answerTokens[index + offset] === token),
    );
  };

  return concepts.filter((concept) => present(concept) || (aliases[concept] ?? []).some(present));
}

function tokenizeConcept(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9+#]+/g) ?? [];
}

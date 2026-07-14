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
  focus_type?: InterviewFocusArea['focus_type'] | null;
  priority: number;
  seniority_target: string;
  drill_budget: number;
  what_to_probe: string;
  seed_question: string;
  question_bank_item_id?: string;
  question_bank_key?: string;
  question_source?: string;
  rubric_dimensions?: string[];
  expected_signals?: string[];
  cv_evidence_excerpt?: string;
  jd_requirement_text?: string;
}

export interface InterviewAgenda {
  topics: AgendaTopic[];
  turn_budget: number;
  uncovered: AgendaTopic[];
}

export const TURN_BUDGET_BY_TIER: Record<string, number> = { free: 6, paid: 12 };
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
  // extras budgets: screening 1 + scenario CHAIN 3 + behavioral 1 + closing slack 1 (I-REAL-2).
  const reserved = includeExtras ? 6 : 2;
  // paid earns the 4-rung drill ladder (application→tradeoff→edge→design); free keeps breadth.
  const maxDrill = includeExtras ? 4 : 3;

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
    focus_type: focus.focus_type,
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
    const budget = Math.min(maxDrill, remaining);
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
      // 3-turn incident CHAIN (I-REAL-2): the ask prompt evolves the same incident each turn
      // based on the candidate's last action — a mini-simulation, not a one-off question.
      drill_budget: 3,
      what_to_probe: `incident handling and real working process on ${top.display_name}`,
      seed_question: `Picture a real incident: something around ${top.display_name} just broke in production and users are affected. Walk me through exactly what you would do first.`,
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

export interface TurnDecisionInput {
  signal: DepthSignal;
  drill_depth: number;
  drill_budget: number;
  turns_used: number;
  turn_budget: number;
  evasive_streak: number;
  seniority_target: string;
}

/**
 * Turn decision trace (Wave I-REAL, spec §7). Additive: explains WHY the engine picked a turn
 * action, in the compact spec vocabulary (`push_harder` collapses into `drill` — still probing
 * the same topic, the push intent survives in `reasons`). Compact reason slugs only — never the
 * prompt or model chain.
 */
export interface InterviewTurnTrace {
  action: 'ask' | 'drill' | 'move_on' | 'wrap';
  phase: string;
  topic_id?: string;
  reasons: string[];
  depth: number;
  remaining_turn_budget: number;
  confidence: 'high' | 'medium' | 'low';
}

const TRACE_ACTION: Record<TurnAction, InterviewTurnTrace['action']> = {
  drill: 'drill',
  push_harder: 'drill',
  advance: 'move_on',
  wrap: 'wrap',
};

/**
 * SINGLE SOURCE of the turn-decision rules — decideTurn and decideTurnWithTrace both route
 * through here so the action and its reasons can never drift apart. Branch order is exactly the
 * pre-trace decideTurn order (behavior-identical refactor).
 */
function decide(input: TurnDecisionInput): { action: TurnAction; reasons: string[] } {
  if (input.turns_used >= input.turn_budget - 1) {
    return { action: 'wrap', reasons: ['turn_budget_exhausted'] };
  }
  if (input.turns_used >= input.turn_budget - 2 && input.drill_depth === 0) {
    return { action: 'wrap', reasons: ['turn_budget_low_at_topic_boundary'] };
  }
  if (input.evasive_streak >= 2) {
    return { action: 'advance', reasons: ['evasive_streak', 'move_on_fairly'] };
  }
  if (input.signal === 'evasive' && input.drill_depth >= 1) {
    return { action: 'advance', reasons: ['evasive_after_follow_up', 'move_on_fairly'] };
  }
  if (input.drill_depth >= input.drill_budget - 1) {
    return { action: 'advance', reasons: ['drill_budget_reached'] };
  }
  if (input.signal === 'deep') {
    const fresher = EARLY_CAREER_BANDS.has(input.seniority_target.trim().toLowerCase());
    const pastHalf = input.drill_depth >= Math.ceil(input.drill_budget / 2);
    if (fresher) return { action: 'advance', reasons: ['deep_answer', 'early_career_no_push'] };
    if (pastHalf) return { action: 'advance', reasons: ['deep_answer', 'drill_past_half_budget'] };
    return { action: 'push_harder', reasons: ['deep_answer_push_for_depth'] };
  }
  const reasons =
    input.signal === 'evasive'
      ? ['answer_evasive', 'one_fair_follow_up']
      : [`answer_${input.signal}`, 'drill_budget_available'];
  return { action: 'drill', reasons };
}

export function decideTurn(input: TurnDecisionInput): TurnAction {
  return decide(input).action;
}

/**
 * decideTurn + explainability (Wave I-REAL). Same rules, same action — plus the compact trace the
 * platform layer returns on `/api/interview/turn`. Confidence is `high` here (the rules are
 * deterministic); the platform layer downgrades it when it had to fall back (e.g. seed question).
 */
export function decideTurnWithTrace(
  input: TurnDecisionInput & { phase: string; topic_id?: string },
): { action: TurnAction; trace: InterviewTurnTrace } {
  const { action, reasons } = decide(input);
  return {
    action,
    trace: {
      action: TRACE_ACTION[action],
      phase: input.phase,
      topic_id: input.topic_id,
      reasons,
      depth: input.drill_depth,
      remaining_turn_budget: Math.max(0, input.turn_budget - input.turns_used),
      confidence: 'high',
    },
  };
}

/**
 * Drill ladder (I-REAL-2): the CODE-owned rung a drill/push question should target at a given
 * depth — how a real interviewer climbs: how they did it → why this over X → where it breaks →
 * how it changes at scale. Early-career bands cap at `tradeoff` (fair bar, no design grilling).
 * The rung is derived from state, never the LLM, so the ladder cannot drift.
 */
export type DrillLadderRung = 'application' | 'tradeoff' | 'edge_failure' | 'design';

const DRILL_LADDER: DrillLadderRung[] = ['application', 'tradeoff', 'edge_failure', 'design'];
const EARLY_CAREER_LADDER: DrillLadderRung[] = ['application', 'application', 'tradeoff'];

export function drillLadderRung(drillDepth: number, seniorityTarget: string): DrillLadderRung {
  const ladder = EARLY_CAREER_BANDS.has(seniorityTarget.trim().toLowerCase())
    ? EARLY_CAREER_LADDER
    : DRILL_LADDER;
  return ladder[Math.max(0, Math.min(drillDepth, ladder.length - 1))];
}

/**
 * Anti-template guard (I-REAL-2): a drill/push follow-up must reuse at least one content term
 * from the candidate's answer / current thread / topic terms — a question with zero overlap is
 * template-shaped ("tell me about your strengths") and gets flagged in the turn trace. Same
 * tokenizer and honest ASCII limits as filterRecognizedConcepts; overlap is a narrowing signal,
 * not proof of quality.
 */
export function isGroundedFollowUp(question: string, contextTexts: string[]): boolean {
  const contextTokens = new Set(contextTexts.flatMap(tokenizeConcept));
  if (contextTokens.size === 0) return false;
  return tokenizeConcept(question).some(
    (token) => token.length >= 4 && !GAP_FILLER.has(token) && contextTokens.has(token),
  );
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

/**
 * Assessment filler the model uses to phrase ANY gap ("did not explain…", "vague answer…").
 * These tokens never anchor a gap to a topic; only what is left after removing them can.
 * Non-diacritic Vietnamese filler is listed explicitly — diacritic words shatter below the
 * 3-char gate in tokenizeConcept (ASCII-only) and drop out on their own.
 */
const GAP_FILLER: ReadonlySet<string> = new Set([
  'the',
  'and',
  'for',
  'with',
  'without',
  'into',
  'from',
  'about',
  'their',
  'they',
  'that',
  'this',
  'than',
  'then',
  'was',
  'were',
  'has',
  'have',
  'had',
  'does',
  'did',
  'not',
  'none',
  'only',
  'very',
  'more',
  'most',
  'some',
  'any',
  'how',
  'what',
  'when',
  'why',
  'which',
  'who',
  'answer',
  'answers',
  'answered',
  'candidate',
  'question',
  'response',
  'mention',
  'mentioned',
  'mentions',
  'explain',
  'explains',
  'explained',
  'explanation',
  'describe',
  'describes',
  'described',
  'description',
  'detail',
  'details',
  'detailed',
  'specific',
  'specifics',
  'specifically',
  'concrete',
  'example',
  'examples',
  'missing',
  'misses',
  'lack',
  'lacks',
  'lacking',
  'weak',
  'unclear',
  'vague',
  'shallow',
  'generic',
  'deep',
  'depth',
  'deeper',
  'unable',
  'cannot',
  'could',
  'couldnt',
  'didnt',
  'doesnt',
  'give',
  'gives',
  'gave',
  'show',
  'shows',
  'showed',
  'khong',
  'chua',
  'thieu',
  'duoc',
  'cach',
  'noi',
  'nen',
  'hon',
]);

/**
 * Grounds the per-turn `gaps_revealed` narrative the same way filterRecognizedConcepts grounds
 * recognized_concepts — token match, no semantics. A gap is about what is MISSING from the
 * answer, so it cannot be required to appear in the answer text; instead each gap phrase must
 * anchor at least one key term (token >= 3 chars, not assessment filler) in the topic universe
 * (asked question + agenda topic terms). Same tokenizer and therefore the same honest limits as
 * the concept filter: ASCII-only, so Vietnamese diacritic words shatter into short fragments and
 * grounding rides on the ASCII tech terms (react, kafka, sql…) — exactly where a fabricated
 * off-topic weakness would smuggle a skill in. A phrase with no anchorable key term is dropped:
 * the assess prompt demands topic-specific gaps, and an unanchorable phrase is unverifiable.
 * Token overlap is a narrowing filter, not proof — an on-topic-sounding fabrication that reuses
 * a topic term still passes, exactly like the concept filter's limits.
 */
export function filterGroundedGaps(gaps: string[], universeTerms: string[]): string[] {
  const universeTokens = new Set(universeTerms.flatMap(tokenizeConcept));
  return gaps.filter((gap) =>
    tokenizeConcept(gap).some(
      (token) => token.length >= 3 && !GAP_FILLER.has(token) && universeTokens.has(token),
    ),
  );
}

function tokenizeConcept(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9+#]+/g) ?? [];
}

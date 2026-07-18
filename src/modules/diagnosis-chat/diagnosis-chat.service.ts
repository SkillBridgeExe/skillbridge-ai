import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../../infrastructure/llm/llm.service';
import { ToolRegistry } from '../../infrastructure/tools/tool-registry.service';
import { runChatToolLoop } from '../../infrastructure/tools/chat-tool-loop';
import { mightNeedTool, toolDeclarationsForFlow } from '../../infrastructure/tools/declarations';
import { PromptsService } from '../prompts/prompts.service';
import {
  DiagnosisChatResult,
  DiagnosisFacts,
  DiagnosisKnownState,
  DIAGNOSIS_DIMENSION_KEYS,
  groundDiagnosis,
} from './diagnosis-grounding';
import {
  buildTurnContext,
  coveredGapNames,
  ensureAskBack,
  factsForIntent,
} from './conversation-state';

const PROMPT_CODE = 'diagnosis_chat_v1';
const MAX_HISTORY = 10; // bounded window (mirror learning-chat MAX_HISTORY)
const DEFAULT_TEMPERATURE = 0.3;
const MAX_OUTPUT_TOKENS = 600;
const FLOW = 'diagnosis_chat';

/** Schema-enforced output (audit F1) — defense-in-depth alongside groundDiagnosis. cited_dimension is
 *  constrained to the 4 real dimension keys; cited_gap_id is a free string (post-verified against FACTS). */
// NOTE: the OpenAI provider sends this with `strict: true`, and OpenAI structured
// output REQUIRES `required` to list EVERY key in `properties` — optional fields are
// expressed as nullable unions, not by omission from `required`. (A `required:['message']`
// schema is rejected with: "400 Invalid schema ... Missing 'cited_dimension'", which
// silently degraded every chat turn to the deterministic fallback.) `null` means
// "no citation / no suggestion" — groundDiagnosis drops a null/invalid citation anyway.
export const DIAGNOSIS_CHAT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'message',
    'cited_dimension',
    'cited_gap_id',
    'cited_other_match_index',
    'cited_tool',
    'suggested_next_step',
  ],
  properties: {
    message: { type: 'string' },
    cited_dimension: { type: ['string', 'null'], enum: [...DIAGNOSIS_DIMENSION_KEYS, null] },
    cited_gap_id: { type: ['string', 'null'] },
    cited_other_match_index: { type: ['number', 'null'] },
    cited_tool: {
      type: ['string', 'null'],
      enum: ['github.enrich', 'roadmap.progress', 'interview.history', null],
    },
    suggested_next_step: { type: ['string', 'null'] },
  },
};

export interface DiagnosisChatHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  /** ISO created_at of the persisted row — read only by the deadline-expiry rule (Wave 3). */
  at?: string;
}

export interface DiagnosisChatTurnInput {
  question: string;
  /** Deterministic user FACTS (their CV-review + gaps) — built by the caller via buildDiagnosisFacts. */
  facts: DiagnosisFacts;
  language?: string;
  /** The section the user is viewing — used only to EMPHASIZE, never to change facts. */
  focus?: string;
  /** Prior conversation (the platform layer loads + persists it); bounded to the last N here. */
  history?: DiagnosisChatHistoryMessage[];
  /** Present only on the real (authenticated) platform turn — gates the tool loop (#22 PR3) and is
   *  threaded into ToolContext for rate-limiting + audit. Absent in unit tests → tool loop skipped. */
  userId?: string;
  /** Threaded into ToolContext for tool-call audit (ai_tool_calls.ai_request_id); optional. */
  aiRequestId?: string;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * One grounded CV-diagnosis advisor turn: render diagnosis_chat_v1 over the user's FACTS → schema-enforced
 * LLM call → groundDiagnosis (drop fabricated dimension/gap citations, strip raw URLs, deterministic
 * grounded fallback). The LLM only PHRASES; code owns the facts + the grounding boundary.
 *
 * Resilience: an LLM transport error (timeout / 429 / 5xx → ServiceUnavailableException) must NOT 500 the
 * turn — groundDiagnosis(null, facts) serves the honest fallback built from the user's own prioritized
 * actions (mirrors learning-chat / trends-insight). IO-light (no DB) so the AI-lane flow is fully testable
 * without cross-lane wiring; the platform layer wraps persistence + quota + tracing.
 */
@Injectable()
export class DiagnosisChatService {
  private readonly logger = new Logger(DiagnosisChatService.name);

  constructor(
    private readonly llm: LlmService,
    private readonly prompts: PromptsService,
    private readonly registry: ToolRegistry,
  ) {}

  async turn(input: DiagnosisChatTurnInput): Promise<DiagnosisChatResult> {
    const language = input.language ?? 'vi';
    // The platform passes a WIDER window than the prompt shows (memory beyond 10 messages lives in
    // the extracted state + the licensed conversation numbers, not in a longer transcript).
    const allHistory = input.history ?? [];
    const history = allHistory
      .slice(-MAX_HISTORY)
      .map((m) => `${m.role}: ${m.content}`)
      .join('\n');

    // Conversation brain (Phase B): deterministic state (their role/deadline, what we already
    // asked) + intent route. Greetings/thanks/meta are answered by CODE — warm, instant, zero
    // fabrication surface — and never reach the LLM or the tool loop.
    const ctx = buildTurnContext(input.facts, allHistory, input.question, language);
    // The memory mirror rides EVERY return path — code-extracted state, so echoing it back is
    // exact by definition. A canned/fallback turn must not blank the FE card.
    const knownState: DiagnosisKnownState = {
      target_role: ctx.state.target_role,
      deadline: ctx.state.deadline,
      covered_gaps: coveredGapNames(input.facts, allHistory),
    };
    if (ctx.canned !== null) {
      return {
        answer: ctx.canned,
        suggested_next_step: null,
        answer_kind: 'canned',
        grounded_facts: [],
        known_state: knownState,
      };
    }

    // System = truth rules (frontmatter of the chat prompt) + PERSONA (body of the character
    // sheet — a versioned prompt asset). Two separate layers on purpose: gate changes must never
    // shift the personality, and a voice rewrite must never touch the rules (Wave 1).
    const character = this.prompts.get('mascot_character_v1').body.trim();
    const system = [this.prompts.get(PROMPT_CODE).meta.system ?? '', character]
      .filter(Boolean)
      .join('\n\n');
    const renderPrompt = (facts: DiagnosisFacts) =>
      this.prompts.render(PROMPT_CODE, {
        language,
        facts: JSON.stringify(facts, null, 2),
        context: ctx.contextBlock,
        history: history || '(no prior messages)',
        focus: input.focus ?? '(none)',
        question: input.question,
      });

    // What the candidate has already said this conversation — their own numbers are honest to repeat
    // back (a deadline, a count), so groundDiagnosis may speak them. Built from the FULL window, so
    // a deadline stated 30 messages ago stays speakable even after it leaves the prompt transcript.
    // USER turns ONLY: licensing the assistant's own digits let an exempt "1-2 bullet" in turn N
    // launder a fabricated "Điểm mục này là 7" in turn N+1 (probe-confirmed 2026-07-17).
    const candidateSaid = [
      ...allHistory.filter((m) => m.role === 'user').map((m) => m.content),
      input.question,
    ]
      .filter(Boolean)
      .join('\n');
    // The advisor's own prior turns — the refusal-escalation counter reads its served copy off
    // this. Separate from candidateSaid so a user QUOTING the refusal can't fake an escalation.
    const advisorSaid = allHistory
      .filter((m) => m.role === 'assistant')
      .map((m) => m.content)
      .filter(Boolean)
      .join('\n');

    // Wave 3 (3C): a non-comparison turn does not need other people's JDs in context. The SAME
    // trimmed object feeds the prompt AND groundDiagnosis below, so the gate licenses exactly
    // what the model saw — an other-match score on an advice turn is now an ungrounded number.
    let facts = factsForIntent(input.facts, ctx.intent);
    const declarations = toolDeclarationsForFlow(FLOW);
    if (declarations.length > 0 && input.userId && mightNeedTool(FLOW, input.question)) {
      const loop = await runChatToolLoop(
        FLOW,
        this.llm,
        this.registry,
        declarations,
        [
          { role: 'system', content: system },
          { role: 'user', content: renderPrompt(facts) },
        ],
        { userId: input.userId, aiRequestId: input.aiRequestId, turnText: input.question },
      );
      if (Object.keys(loop.toolFacts).length > 0) {
        facts = { ...facts, tool_results: loop.toolFacts };
      }
    }

    const userPrompt = renderPrompt(facts);
    let parsed: unknown = null;
    try {
      const result = await this.llm.complete(
        [
          { role: 'system', content: system },
          { role: 'user', content: userPrompt },
        ],
        {
          jsonMode: true,
          responseSchema: DIAGNOSIS_CHAT_SCHEMA,
          temperature: DEFAULT_TEMPERATURE,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          model: process.env.DIAGNOSIS_CHAT_MODEL || undefined,
        },
      );
      parsed = result.parsedJson ?? safeParse(result.text);
      const grounded = groundDiagnosis(parsed, facts, language, candidateSaid, advisorSaid);
      return {
        ...grounded,
        known_state: knownState,
        // Ask-back backstop: code decided WHEN to ask; if the model dropped the question anyway
        // (measured: obeyed 1 of 4 directive turns), code appends the standard one.
        answer: ensureAskBack(grounded.answer, ctx.ask, language),
        trace: {
          promptTokens: result.tokenUsage?.promptTokens ?? 0,
          completionTokens: result.tokenUsage?.completionTokens ?? 0,
          totalTokens: result.tokenUsage?.totalTokens ?? 0,
          latencyMs: result.latencyMs ?? 0,
          modelCode: result.modelCode ?? '',
          ...(result.estimatedCostUsd === undefined
            ? {}
            : { estimatedCostUsd: result.estimatedCostUsd }),
        },
      };
    } catch (err) {
      this.logger.warn(
        `diagnosis_chat LLM call failed — serving grounded fallback: ${(err as Error).message}`,
      );
    }

    // On a failed/empty call, parsed stays null → groundDiagnosis returns the deterministic fallback,
    // localized via `language` so an English user is not answered in Vietnamese on every LLM failure.
    const fallback = groundDiagnosis(parsed, facts, language, candidateSaid, advisorSaid);
    return {
      ...fallback,
      known_state: knownState,
      answer: ensureAskBack(fallback.answer, ctx.ask, language),
    };
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../../infrastructure/llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';
import { CvBuilderChatFacts } from './cv-builder-chat.facts';
import { CvBuilderChatResult, CvBuilderKnownState, groundCvChat } from './cv-chat-grounding';
import { CV_BUILDER_CHAT_SCHEMA } from './cv-builder-chat.schema';
import { buildTurnContext, ensureAskBack } from './cv-builder-conversation-state';

const PROMPT_CODE = 'cv_builder_chat_v1';
const CHARACTER_CODE = 'mascot_character_cvbuilder_v1';
const MAX_HISTORY = 40; // bounded prompt-transcript window (mirror diagnosis-chat's MAX_HISTORY)
const DEFAULT_TEMPERATURE = 0.3;
const MAX_OUTPUT_TOKENS = 600;

export interface CvBuilderChatHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  at?: string;
}

export interface CvBuilderChatTurnInput {
  question: string;
  /** Deterministic facts about the user's own CV draft — built by the caller via buildCvBuilderFacts. */
  facts: CvBuilderChatFacts;
  language?: string;
  history?: CvBuilderChatHistoryMessage[];
  userId?: string;
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
 * One grounded CV-builder companion turn: conversation brain (`buildTurnContext` — deterministic
 * state + intent route + canned short-circuit) → render cv_builder_chat_v1 over the user's own draft
 * FACTS → schema-enforced LLM call → groundCvChat (drop any fabricated number/tech/url/entity/
 * credential/date, verify a proposed edit against the shipped rewrite anti-invention counter) →
 * `ensureAskBack` backstop. The LLM only PHRASES; code owns the facts, the ask-WHEN decision, and the
 * grounding boundary.
 *
 * Still no tool loop (Slice 2 is state/intent/ask only) — CV-builder tools are dormant per spec (the
 * draft is read server-side as facts), so this depends on LlmService + PromptsService only. IO-light
 * (no DB) so the AI-lane flow is fully testable without cross-lane wiring; the platform layer wraps
 * persistence + quota + tracing.
 *
 * Resilience: an LLM transport error (timeout / 429 / 5xx) must NOT 500 the turn — groundCvChat(null, ...)
 * serves the deterministic honest fallback (mirrors diagnosis-chat). `known_state` (mirrored from
 * `ctx.state`) rides EVERY return path, including canned and fallback, so the FE memory card is never
 * blanked.
 */
@Injectable()
export class CvBuilderChatService {
  private readonly logger = new Logger(CvBuilderChatService.name);

  constructor(
    private readonly llm: LlmService,
    private readonly prompts: PromptsService,
  ) {}

  async turn(input: CvBuilderChatTurnInput): Promise<CvBuilderChatResult> {
    const language = input.language ?? 'vi';
    const allHistory = input.history ?? [];
    const history = allHistory
      .slice(-MAX_HISTORY)
      .map((m) => `${m.role}: ${m.content}`)
      .join('\n');

    // Conversation brain (Slice 2): deterministic state (active field, restated target role,
    // answered/asked bullet gaps) + intent route. Greetings/thanks/meta are answered by CODE — warm,
    // instant, zero fabrication surface — and never reach the LLM.
    const ctx = buildTurnContext(input.facts, allHistory, input.question, language);
    // The memory mirror rides EVERY return path — code-extracted state, so echoing it back is exact
    // by definition. A canned/fallback turn must not blank the FE card. Shape matches
    // CvBuilderKnownState (cv-chat-grounding.ts): gap KIND only, never the opaque field_path.
    const knownState: CvBuilderKnownState = {
      target_role: ctx.state.target_role,
      active_field_path: ctx.state.active_field_path,
      answered_gaps: ctx.state.answered_gaps.map((g) => g.gap),
    };
    if (ctx.canned !== null) {
      return {
        answer: ctx.canned,
        answer_kind: 'canned',
        proposed_edit: null,
        grounded_facts: [],
        suggested_next_step: null,
        known_state: knownState,
      };
    }

    // System = truth rules (frontmatter of the chat prompt) + PERSONA (body of the CV-builder
    // character sheet) — same two-layer split as diagnosis-chat, using the CV persona (Task 1.5).
    const character = this.prompts.get(CHARACTER_CODE).body.trim();
    const system = [this.prompts.get(PROMPT_CODE).meta.system ?? '', character]
      .filter(Boolean)
      .join('\n\n');
    const userPrompt = this.prompts.render(PROMPT_CODE, {
      language,
      facts: JSON.stringify(input.facts, null, 2),
      focus: input.facts.focus ? JSON.stringify(input.facts.focus, null, 2) : '(none)',
      history: history || '(no prior messages)',
      context: ctx.contextBlock,
      question: input.question,
    });

    // What the candidate has already said this conversation — their own numbers are honest to
    // repeat back, so groundCvChat may speak them. USER turns ONLY: licensing the assistant's own
    // digits would let an exempt phrase in turn N launder a fabricated number in turn N+1
    // (probe-confirmed pattern on diagnosis-chat, 2026-07-17) — never include assistant turns here.
    const candidateSaid = [
      ...allHistory.filter((m) => m.role === 'user').map((m) => m.content),
      input.question,
    ]
      .filter(Boolean)
      .join('\n');

    let parsed: unknown = null;
    try {
      const result = await this.llm.complete(
        [
          { role: 'system', content: system },
          { role: 'user', content: userPrompt },
        ],
        {
          jsonMode: true,
          responseSchema: CV_BUILDER_CHAT_SCHEMA,
          temperature: DEFAULT_TEMPERATURE,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          model: process.env.CV_BUILDER_CHAT_MODEL || undefined,
        },
      );
      parsed = result.parsedJson ?? safeParse(result.text);
      const grounded = groundCvChat(parsed, input.facts, language, candidateSaid);
      return {
        ...grounded,
        // Ask-back backstop: code decided WHEN to ask (`ctx.ask`); if the model dropped the
        // question anyway (measured on the sibling companion: obeyed ~1 of 4 directive turns),
        // code appends the standard one.
        answer: ensureAskBack(grounded.answer, ctx.ask, language),
        known_state: knownState,
        trace: {
          promptTokens: result.tokenUsage?.promptTokens ?? 0,
          completionTokens: result.tokenUsage?.completionTokens ?? 0,
          totalTokens: result.tokenUsage?.totalTokens ?? 0,
          latencyMs: result.latencyMs ?? 0,
        },
      };
    } catch (err) {
      this.logger.warn(
        `cv_builder_chat LLM call failed — serving grounded fallback: ${(err as Error).message}`,
      );
    }

    // On a failed/empty call the LLM never produced `parsed` → groundCvChat(null, ...) returns the
    // deterministic fallback, localized via `language` so an English user is not answered in
    // Vietnamese on every LLM failure.
    return { ...groundCvChat(null, input.facts, language, candidateSaid), known_state: knownState };
  }
}

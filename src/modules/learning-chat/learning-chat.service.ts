import { Injectable, Logger } from '@nestjs/common';
import { maskPii } from '../../common/services/pii-mask';
import { LlmService } from '../../infrastructure/llm/llm.service';
import { ToolRegistry } from '../../infrastructure/tools/tool-registry.service';
import { runChatToolLoop } from '../../infrastructure/tools/chat-tool-loop';
import { toolDeclarationsForFlow } from '../../infrastructure/tools/declarations';
import { PromptsService } from '../prompts/prompts.service';
import { LearningResourceRetriever } from '../roadmap/learning-resource-retriever.service';
import { RetrievedResource } from '../roadmap/resource-embedding';
import { ChatFacts, GroundedAnswer, groundResources } from './chat-grounding';

const PROMPT_CODE = 'learning_chat_v1';
const MAX_HISTORY = 10; // bounded window (mirror interview MAX_ANSWER_HISTORY_TURNS)
const DEFAULT_TOPK = 6;
const FLOW = 'learning_chat';

/** Schema-enforced output (audit F1) — defense-in-depth alongside groundResources. */
export const CHAT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['message', 'cited_resource_ids', 'suggested_next_step'],
  properties: {
    message: { type: 'string' },
    cited_resource_ids: { type: 'array', items: { type: 'string' } },
    suggested_next_step: { type: ['string', 'null'] },
  },
};

export interface ChatHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatTurnInput {
  question: string;
  language?: string;
  /** Prior conversation (the platform layer loads + persists it); bounded to the last N here. */
  history?: ChatHistoryMessage[];
  /** Deterministic user FACTS (their open gaps) — built by the caller via buildChatFacts. Optional. */
  facts?: ChatFacts;
  topK?: number;
  /** Present only on the real (authenticated) platform turn — gates the tool loop (#22 PR3) and is
   *  threaded into ToolContext for rate-limiting + audit. Absent in unit tests → tool loop skipped. */
  userId?: string;
  /** Threaded into ToolContext for tool-call audit (ai_tool_calls.ai_request_id); optional. */
  aiRequestId?: string;
}

export interface ChatTurnResult extends GroundedAnswer {
  retrieved: RetrievedResource[];
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The resource shape the prompt sees: NO raw url (the bot cites resource_id; the API resolves the link). */
function promptResource(r: RetrievedResource) {
  return {
    resource_id: r.resource_id,
    title: r.title,
    provider: r.provider,
    source_type: r.source_type,
    outcome_type: r.outcome_type,
    proof_of_completion: r.proof_of_completion ?? null,
  };
}

/**
 * A grounded learning-chatbot turn: retrieve real catalog resources → render learning_chat_v1 over the
 * retrieved set + the user's FACTS → schema-enforced + PII-masked LLM call → groundResources (drop any
 * fabricated id, strip raw URLs, honest empty-state). The LLM only phrases; code owns retrieval + grounding.
 *
 * The platform layer (conversation persistence, gap-report fetch, HTTP) wraps this — see the handoff note.
 * `turn` is deliberately IO-light (no DB) so the AI-lane flow is complete + testable without cross-lane wiring.
 */
@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly retriever: LearningResourceRetriever,
    private readonly llm: LlmService,
    private readonly prompts: PromptsService,
    private readonly registry: ToolRegistry,
  ) {}

  async turn(input: ChatTurnInput): Promise<ChatTurnResult> {
    const language = input.language ?? 'vi';
    const maskedQuestion = maskPii(input.question);
    let facts = input.facts ?? { open_gaps: [] };

    const retrieved = await this.retriever.nearest({
      query: maskedQuestion,
      language,
      topK: input.topK ?? DEFAULT_TOPK,
    });

    const history = (input.history ?? [])
      .slice(-MAX_HISTORY)
      .map((m) => `${m.role}: ${maskPii(m.content)}`)
      .join('\n');

    const system = this.prompts.get(PROMPT_CODE).meta.system ?? '';
    const renderPrompt = (f: ChatFacts) =>
      this.prompts.render(PROMPT_CODE, {
        language,
        user_context: JSON.stringify(f, null, 2),
        resources: JSON.stringify(retrieved.map(promptResource), null, 2),
        history: history || '(no prior messages)',
        question: maskedQuestion,
      });

    const declarations = toolDeclarationsForFlow(FLOW);
    if (declarations.length > 0 && input.userId) {
      const loop = await runChatToolLoop(
        FLOW,
        this.llm,
        this.registry,
        declarations,
        [
          { role: 'system', content: system },
          { role: 'user', content: renderPrompt(facts) },
        ],
        { userId: input.userId, aiRequestId: input.aiRequestId },
      );
      if (Object.keys(loop.toolFacts).length > 0) {
        facts = { ...facts, tool_results: loop.toolFacts };
      }
    }

    const userPrompt = renderPrompt(facts);
    // Resilience: an LLM transport error (timeout / 429 / 5xx → ServiceUnavailableException) must NOT 500 the
    // turn. groundResources(null, retrieved, facts) already serves the honest grounded fallback over the
    // retrieved set (mirrors trends-insight / interview-plan). Previously only bad/empty MODEL OUTPUT was
    // covered — a failing CALL now degrades the same deterministic way.
    let parsed: unknown = null;
    try {
      const result = await this.llm.complete(
        [
          { role: 'system', content: system },
          { role: 'user', content: userPrompt },
        ],
        { jsonMode: true, responseSchema: CHAT_SCHEMA, temperature: 0.3, maxOutputTokens: 700 },
      );
      parsed = result.parsedJson ?? safeParse(result.text);
    } catch (err) {
      this.logger.warn(
        `learning_chat LLM call failed — serving grounded fallback: ${(err as Error).message}`,
      );
    }

    const grounded = groundResources(parsed, retrieved, facts);
    return { ...grounded, retrieved };
  }
}

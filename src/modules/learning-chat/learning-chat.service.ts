import { Injectable } from '@nestjs/common';
import { maskPii } from '../../common/services/pii-mask';
import { LlmService } from '../../infrastructure/llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';
import { LearningResourceRetriever } from '../roadmap/learning-resource-retriever.service';
import { RetrievedResource } from '../roadmap/resource-embedding';
import { ChatFacts, GroundedAnswer, groundResources } from './chat-grounding';

const PROMPT_CODE = 'learning_chat_v1';
const MAX_HISTORY = 10; // bounded window (mirror interview MAX_ANSWER_HISTORY_TURNS)
const DEFAULT_TOPK = 6;

/** Schema-enforced output (audit F1) — defense-in-depth alongside groundResources. */
const CHAT_SCHEMA: Record<string, unknown> = {
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
  constructor(
    private readonly retriever: LearningResourceRetriever,
    private readonly llm: LlmService,
    private readonly prompts: PromptsService,
  ) {}

  async turn(input: ChatTurnInput): Promise<ChatTurnResult> {
    const language = input.language ?? 'vi';
    const maskedQuestion = maskPii(input.question);
    const facts = input.facts ?? { open_gaps: [] };

    const retrieved = await this.retriever.nearest({
      query: maskedQuestion,
      language,
      topK: input.topK ?? DEFAULT_TOPK,
    });

    const history = (input.history ?? [])
      .slice(-MAX_HISTORY)
      .map((m) => `${m.role}: ${maskPii(m.content)}`)
      .join('\n');

    const userPrompt = this.prompts.render(PROMPT_CODE, {
      language,
      user_context: JSON.stringify(facts, null, 2),
      resources: JSON.stringify(retrieved.map(promptResource), null, 2),
      history: history || '(no prior messages)',
      question: maskedQuestion,
    });

    const system = this.prompts.get(PROMPT_CODE).meta.system ?? '';
    const result = await this.llm.complete(
      [
        { role: 'system', content: system },
        { role: 'user', content: userPrompt },
      ],
      { jsonMode: true, responseSchema: CHAT_SCHEMA, temperature: 0.3, maxOutputTokens: 700 },
    );

    const parsed = result.parsedJson ?? safeParse(result.text);
    const grounded = groundResources(parsed, retrieved, facts);
    return { ...grounded, retrieved };
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../../infrastructure/llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';
import {
  DiagnosisChatResult,
  DiagnosisFacts,
  DIAGNOSIS_DIMENSION_KEYS,
  groundDiagnosis,
} from './diagnosis-grounding';

const PROMPT_CODE = 'diagnosis_chat_v1';
const MAX_HISTORY = 10; // bounded window (mirror learning-chat MAX_HISTORY)
const DEFAULT_TEMPERATURE = 0.3;
const MAX_OUTPUT_TOKENS = 600;

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
  required: ['message', 'cited_dimension', 'cited_gap_id', 'suggested_next_step'],
  properties: {
    message: { type: 'string' },
    cited_dimension: { type: ['string', 'null'], enum: [...DIAGNOSIS_DIMENSION_KEYS, null] },
    cited_gap_id: { type: ['string', 'null'] },
    suggested_next_step: { type: ['string', 'null'] },
  },
};

export interface DiagnosisChatHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
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
  ) {}

  async turn(input: DiagnosisChatTurnInput): Promise<DiagnosisChatResult> {
    const language = input.language ?? 'vi';

    const history = (input.history ?? [])
      .slice(-MAX_HISTORY)
      .map((m) => `${m.role}: ${m.content}`)
      .join('\n');

    const userPrompt = this.prompts.render(PROMPT_CODE, {
      language,
      facts: JSON.stringify(input.facts, null, 2),
      history: history || '(no prior messages)',
      focus: input.focus ?? '(none)',
      question: input.question,
    });
    const system = this.prompts.get(PROMPT_CODE).meta.system ?? '';

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
      const grounded = groundDiagnosis(parsed, input.facts, language);
      return {
        ...grounded,
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
    return groundDiagnosis(parsed, input.facts, language);
  }
}

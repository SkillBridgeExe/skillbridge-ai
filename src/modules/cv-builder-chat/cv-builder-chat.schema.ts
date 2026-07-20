/** Model-output contract for the cv-builder-chat advisor turn — the LLM only proposes; the grounding
 *  gate (Task 1.4+) decides what's honest to show. Mirrors DIAGNOSIS_CHAT_SCHEMA's shape
 *  (`src/modules/diagnosis-chat/diagnosis-chat.service.ts`): OpenAI structured output with
 *  `strict: true` REQUIRES `required` to list EVERY key in `properties` — optional fields are
 *  nullable unions, never omitted from `required`. Omitting one 400s the API and silently
 *  degrades every turn to fallback. */
export interface CvBuilderChatModelOutput {
  message: string;
  /** Fact phrases the model claims it used — subset-checked against FACTS by the grounding gate. */
  used_facts: string[];
  proposed_edit: { field_path: string; after: string } | null;
  cited_field_path: string | null;
  suggested_next_step: string | null;
}

export const CV_BUILDER_CHAT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['message', 'used_facts', 'proposed_edit', 'cited_field_path', 'suggested_next_step'],
  properties: {
    message: { type: 'string' },
    used_facts: { type: 'array', items: { type: 'string' } },
    proposed_edit: {
      type: ['object', 'null'],
      properties: {
        field_path: { type: 'string' },
        after: { type: 'string' },
      },
      required: ['field_path', 'after'],
      additionalProperties: false,
    },
    cited_field_path: { type: ['string', 'null'] },
    suggested_next_step: { type: ['string', 'null'] },
  },
};

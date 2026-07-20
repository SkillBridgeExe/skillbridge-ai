/** Per-flow tool allow-list (#22 §5 hard rule: a tool not listed here MUST be rejected). */
export const TOOL_ALLOW_LIST: Record<string, string[]> = {
  diagnosis_chat: ['github.enrich', 'roadmap.progress', 'interview.history'],
  learning_chat: ['resource.validate'],
  curation_job: ['resource.validate'],
};

import { LlmToolDeclaration } from '../llm/types/llm.types';
import { TOOL_ALLOW_LIST } from './allow-list';

// USER-REVIEW GATE (spec #22 PR3): tool `description` steers the model's decision to call it —
// treat any change here like a prompt diff, same sign-off as prompts/diagnosis_chat_v1.md.
const TOOL_DECLARATIONS: Record<string, LlmToolDeclaration> = {
  'resource.validate': {
    name: 'resource.validate',
    description:
      'Check whether a learning-resource URL is still reachable. Call this ONLY when the user explicitly asks if a specific link/course still works or is available — never speculatively, never for a URL the user did not mention.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The exact URL to check.' } },
      required: ['url'],
      additionalProperties: false,
    },
  },
  'github.enrich': {
    name: 'github.enrich',
    description:
      "Look up a candidate's PUBLIC GitHub profile (public repos, languages, recent activity) to check real coding evidence for a skill. Call this ONLY when the user asks something GitHub can answer (e.g. 'does my GitHub show React experience?') AND a GitHub username is present in the conversation — never guess or invent a username.",
    parameters: {
      type: 'object',
      properties: {
        username: {
          type: 'string',
          description: 'The GitHub username exactly as given by the user.',
        },
      },
      required: ['username'],
      additionalProperties: false,
    },
  },
  'roadmap.progress': {
    name: 'roadmap.progress',
    description:
      "Read the candidate's OWN learning-roadmap progress (per-skill checklist counts and mastered lessons). Call this ONLY when the user asks how their learning or roadmap is going (e.g. 'mình học tới đâu rồi', 'lộ trình của mình sao rồi'). It takes NO parameters and always reads the current user's own data — never anyone else's.",
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  'interview.history': {
    name: 'interview.history',
    description:
      "Read the candidate's OWN recent mock-interview results (up to 3 completed sessions with overall scores). Call this ONLY when the user asks about their past interview practice or interview scores (e.g. 'mấy buổi phỏng vấn thử của mình sao rồi'). It takes NO parameters and always reads the current user's own data — never anyone else's.",
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
};

export function toolDeclarationsForFlow(flow: string): LlmToolDeclaration[] {
  return (TOOL_ALLOW_LIST[flow] ?? [])
    .map((name) => TOOL_DECLARATIONS[name])
    .filter((d): d is LlmToolDeclaration => Boolean(d));
}

// Cheap deterministic pre-gate — skip the tool-decision LLM call entirely unless the
// question plausibly needs a tool. Keeps the "~2x cost only when a tool is used" model
// the spec describes; false negatives (missing a real tool opportunity) are acceptable,
// false positives (an unnecessary decision call) are what this exists to prevent.
const GITHUB_HINT = /\bgithub\b|\brepo(?:s|sitory)?\b/i;
const LINK_HINT = /https?:\/\/|\blink\b|\burl\b|\bcòn (?:sống|hoạt động)\b|\bvalid\b/i;
// Wave 3 read-tools: false negatives here silently disable a tool, so the nets are wide-ish —
// a false positive only costs one cheap decision call.
const ROADMAP_HINT = /lộ\s*trình|roadmap|tiến\s*độ|học\s+(?:tới|đến|xong)|bài\s+học|khóa\s+học/iu;
const INTERVIEW_HINT = /phỏng\s*vấn|interview|mock/iu;

export function mightNeedTool(flow: string, question: string): boolean {
  if (flow === 'diagnosis_chat') {
    return (
      GITHUB_HINT.test(question) || ROADMAP_HINT.test(question) || INTERVIEW_HINT.test(question)
    );
  }
  if (flow === 'learning_chat') return LINK_HINT.test(question);
  return false;
}

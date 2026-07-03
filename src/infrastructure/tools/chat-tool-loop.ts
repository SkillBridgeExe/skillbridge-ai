import { LlmService } from '../llm/llm.service';
import { LlmMessage, LlmToolDeclaration } from '../llm/types/llm.types';
import { ToolRegistry } from './tool-registry.service';
import { ToolContext } from './types';
import { sanitizeUntrustedFacts } from './injection-defense';

const HOP_BUDGET = 2;
const DECISION_TEMPERATURE = 0.1;
const DECISION_MAX_OUTPUT_TOKENS = 300;

/**
 * Pure: given the decision call's proposed tool calls, which ones execute (hop budget ≤2) and
 * whether the turn is "exceeded". Exported for eval:chat-tools (offline, no LLM/registry mock).
 */
export function applyHopBudget(calls: Array<{ name: string; args: unknown }>): {
  budgeted: Array<{ name: string; args: unknown }>;
  exceeded: boolean;
} {
  return { budgeted: calls.slice(0, HOP_BUDGET), exceeded: calls.length > HOP_BUDGET };
}

export interface ToolLoopOutcome {
  /** Sanitized tool-result facts keyed by tool name — merge into the flow's own FACTS before the
   *  final structured-output call. Empty when no tool was used. */
  toolFacts: Record<string, unknown>;
  /** True when the model asked for more than HOP_BUDGET tool calls, or every attempted call
   *  failed/timed out — the caller proceeds with whatever facts it has (honest, never a throw). */
  degraded: boolean;
}

/**
 * Shared "does this turn need a tool?" decision call (#22 PR3 loop, step 1-3) — used by BOTH
 * diagnosis-chat and learning-chat. Deliberately does NOT set jsonMode/responseSchema on this call
 * (Gemini does not support responseSchema + tools together — verified against @google/genai docs).
 * Never throws: a decision-call failure or a tool failure both degrade to "no tool used", so the
 * caller's normal (already-existing) single-call flow always still runs.
 */
export async function runChatToolLoop(
  flow: string,
  llm: LlmService,
  registry: ToolRegistry,
  declarations: LlmToolDeclaration[],
  messages: LlmMessage[],
  ctx: ToolContext,
): Promise<ToolLoopOutcome> {
  if (declarations.length === 0) return { toolFacts: {}, degraded: false };

  let decision;
  try {
    decision = await llm.complete(messages, {
      tools: declarations,
      temperature: DECISION_TEMPERATURE,
      maxOutputTokens: DECISION_MAX_OUTPUT_TOKENS,
    });
  } catch {
    return { toolFacts: {}, degraded: false };
  }

  const calls = decision.toolCalls ?? [];
  if (calls.length === 0) return { toolFacts: {}, degraded: false };

  const { budgeted, exceeded } = applyHopBudget(calls);

  const toolFacts: Record<string, unknown> = {};
  let anyFailed = false;
  for (const call of budgeted) {
    try {
      const result = await registry.invoke(flow, call.name, call.args, ctx);
      toolFacts[call.name] = sanitizeUntrustedFacts(result);
    } catch {
      anyFailed = true;
    }
  }

  return { toolFacts, degraded: exceeded || anyFailed };
}

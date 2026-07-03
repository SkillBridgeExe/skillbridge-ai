/**
 * Offline eval for the chat tool-calling loop (#22 PR3, no network/LLM calls) — golden fixtures run
 * through the REAL pure functions: groundDiagnosis (cited_tool templating), sanitizeUntrustedFacts
 * (injection defense), applyHopBudget (hop-budget enforcement).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { groundDiagnosis, DiagnosisFacts } from '../modules/diagnosis-chat/diagnosis-grounding';
import { sanitizeUntrustedFacts } from '../infrastructure/tools/injection-defense';
import { applyHopBudget } from '../infrastructure/tools/chat-tool-loop';

export type ChatToolsEvalCase =
  | {
      id: string;
      kind: 'cite-facts';
      parsed: unknown;
      facts: DiagnosisFacts;
      expect_contains: string;
    }
  | {
      id: string;
      kind: 'tool-not-in-facts';
      parsed: unknown;
      facts: DiagnosisFacts;
      expect_not_contains: string;
    }
  | {
      id: string;
      kind: 'hop-budget';
      calls: Array<{ name: string; args: unknown }>;
      expect_budgeted: number;
      expect_exceeded: boolean;
    }
  | {
      id: string;
      kind: 'injection';
      raw: unknown;
      expect_not_contains: string;
      expect_contains: string;
    };

export interface ChatToolsEvalResult {
  id: string;
  pass: boolean;
  detail: string;
}

export function scoreChatToolsCase(c: ChatToolsEvalCase): ChatToolsEvalResult {
  if (c.kind === 'cite-facts') {
    const result = groundDiagnosis(c.parsed, c.facts, 'vi');
    const pass = result.answer.includes(c.expect_contains);
    return {
      id: c.id,
      pass,
      detail: pass ? '' : `answer "${result.answer}" missing "${c.expect_contains}"`,
    };
  }
  if (c.kind === 'tool-not-in-facts') {
    const result = groundDiagnosis(c.parsed, c.facts, 'vi');
    const pass = !result.answer.includes(c.expect_not_contains);
    return {
      id: c.id,
      pass,
      detail: pass
        ? ''
        : `answer leaked "${c.expect_not_contains}" despite no matching tool_results`,
    };
  }
  if (c.kind === 'hop-budget') {
    const { budgeted, exceeded } = applyHopBudget(c.calls);
    const pass = budgeted.length === c.expect_budgeted && exceeded === c.expect_exceeded;
    return {
      id: c.id,
      pass,
      detail: pass ? '' : `got budgeted=${budgeted.length} exceeded=${exceeded}`,
    };
  }
  // injection
  const out = JSON.stringify(sanitizeUntrustedFacts(c.raw));
  const pass =
    !out.toLowerCase().includes(c.expect_not_contains.toLowerCase()) &&
    out.includes(c.expect_contains);
  return {
    id: c.id,
    pass,
    detail: pass ? '' : `sanitized output "${out}" failed injection check`,
  };
}

// CLI runner: `pnpm eval:chat-tools`
if (require.main === module) {
  const golden = JSON.parse(
    readFileSync(join(process.cwd(), 'data', 'eval', 'chat-tools-golden.json'), 'utf8'),
  ) as { cases: ChatToolsEvalCase[] };
  let failed = 0;
  for (const c of golden.cases) {
    const r = scoreChatToolsCase(c);
    if (!r.pass) {
      failed += 1;
      // eslint-disable-next-line no-console
      console.error(`FAIL ${r.id}: ${r.detail}`);
    }
  }
  // eslint-disable-next-line no-console
  console.log(`chat-tools eval: ${golden.cases.length - failed}/${golden.cases.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

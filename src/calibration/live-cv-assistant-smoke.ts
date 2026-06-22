/**
 * --live smoke for the CV Builder Assistant Turn-2 rewrite (calls the REAL LLM).
 *   OPENAI_API_KEY=… pnpm ts-node -r tsconfig-paths/register src/calibration/live-cv-assistant-smoke.ts
 * Proves: (1) the model produces a good grounded rewrite, (2) it PASSES the anti-fabrication gate
 * (not over-rejected), (3) the gate still catches any fabricated number/tech. Directional, not a CI gate.
 */
import * as dotenv from 'dotenv';
import OpenAI from 'openai';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  groundCvAssistantAnswers,
  groundCvRewrite,
  type RewriteModelOutput,
} from '../modules/cv-assistant/cv-assistant-rewrite';
import { CvAnswer, Language } from '../modules/cv-assistant/cv-assistant';

// The NestJS app loads .env via ConfigModule; this standalone script must do it itself.
// override:true so the real key in .env wins over a stale OPENAI_API_KEY exported in the shell.
dotenv.config({ override: true });

const raw = readFileSync(join(process.cwd(), 'prompts', 'cv_assistant_rewrite_v1.md'), 'utf8');
const fm = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
const system = (fm?.[1].match(/^system:\s*(.*)$/m)?.[1] ?? '').trim();
const body = fm?.[2] ?? '';
const render = (vars: Record<string, string>): string =>
  body.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => vars[k] ?? '');

interface Case {
  id: string;
  before: string;
  answers: CvAnswer[];
  language: Language;
}
const CASES: Case[] = [
  {
    id: 'en-basic',
    before: 'Worked on the project.',
    answers: [
      { gap: 'action', option_id: 'built' },
      { gap: 'tech', option_id: 'backend', detail: 'Node.js' },
      { gap: 'result', option_id: 'faster' },
    ],
    language: 'en',
  },
  {
    id: 'en-numbers',
    before: 'Did the backend part.',
    answers: [
      { gap: 'action', option_id: 'built' },
      { gap: 'tech', option_id: 'backend', detail: 'Node.js, PostgreSQL' },
      { gap: 'result', option_id: 'more_users', detail: '10k users' },
    ],
    language: 'en',
  },
  {
    id: 'vi-basic',
    before: 'Em làm dự án nhóm ở trường.',
    answers: [
      { gap: 'action', option_id: 'built' },
      { gap: 'tech', option_id: 'frontend', detail: 'React' },
      { gap: 'result', option_id: 'faster' },
    ],
    language: 'vi',
  },
  {
    id: 'en-temptation', // generic detail — does the model resist adding a fake metric/tech?
    before: 'Helped with the app.',
    answers: [
      { gap: 'action', option_id: 'fixed' },
      { gap: 'tech', option_id: 'frontend', detail: 'React' },
      { gap: 'result', option_id: 'fewer_errors' },
    ],
    language: 'en',
  },
];

async function main(): Promise<void> {
  const client = new OpenAI();
  const model = process.env.CV_ASSISTANT_MODEL || 'gpt-4o-mini';
  let accepted = 0;
  for (const c of CASES) {
    const grounded = groundCvAssistantAnswers(c.answers, c.language);
    const userPrompt = render({
      language: c.language,
      before: c.before,
      facts: grounded.facts.map((f) => `- ${f}`).join('\n'),
    });
    const resp = await client.chat.completions.create({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userPrompt },
      ],
    });
    const parsed = JSON.parse(
      resp.choices[0].message.content ?? '{}',
    ) as Partial<RewriteModelOutput>;
    const verdict = groundCvRewrite(
      c.before,
      { after: parsed.after ?? '', used_facts: parsed.used_facts ?? [] },
      grounded,
      { target: 't', why: 'w' },
    );
    // eslint-disable-next-line no-console
    console.log(
      `\n[${c.id}] facts=${JSON.stringify(grounded.facts)}\n  before: ${c.before}\n  model:  ${parsed.after}\n  used:   ${JSON.stringify(parsed.used_facts)}\n  GATE:   ${verdict.ok ? 'ACCEPT ✅' : 'REJECT ❌ (' + verdict.detail + ')'}`,
    );
    if (verdict.ok) accepted += 1;
  }
  // eslint-disable-next-line no-console
  console.log(`\n=== ${accepted}/${CASES.length} accepted by the gate (model: ${model}) ===`);
}

void main();

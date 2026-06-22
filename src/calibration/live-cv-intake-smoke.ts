/**
 * --live smoke for the CV Intake engine (calls the REAL LLM).
 *   pnpm ts-node -r tsconfig-paths/register src/calibration/live-cv-intake-smoke.ts
 * Proves end-to-end with a real model: (1) it extracts the right fields from a real story,
 * (2) deterministic dates land, (3) the grounding gate keeps every `found` field grounded in the
 * narrative (no fabrication), (4) fields the story omits land in `missing` (not invented).
 * Directional, not a CI gate.
 */
import * as dotenv from 'dotenv';
import OpenAI from 'openai';
import { readFileSync } from 'fs';
import { join } from 'path';
import { assembleExtraction, type IntakeLlmOutput } from '../modules/cv-intake/cv-intake';
import { isGrounded } from '../modules/cv-intake/intake-grounding';

// Standalone script: load .env itself; override:true so the real key wins over a stale shell export.
dotenv.config({ override: true });

const raw = readFileSync(join(process.cwd(), 'prompts', 'cv_intake_experience_v1.md'), 'utf8');
const fm = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
const system = (fm?.[1].match(/^system:\s*(.*)$/m)?.[1] ?? '').trim();
const body = fm?.[2] ?? '';
const render = (vars: Record<string, string>): string =>
  body.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => vars[k] ?? '');

interface Case {
  id: string;
  narrative: string;
  output_lang: 'vi' | 'en';
  note: string;
}
const CASES: Case[] = [
  {
    id: 'vi-full',
    narrative:
      'Tôi làm ở SmartAI Solutions vị trí AI Engineer từ 05/2023 tới nay, xây chatbot nội bộ cho 2000 nhân viên bằng GPT-4o và Claude, giảm thời gian tìm tài liệu từ 15 xuống dưới 2 phút.',
    output_lang: 'vi',
    note: 'rich → expect company/position/start/ongoing/description/achievements all grounded',
  },
  {
    id: 'en-closed',
    narrative:
      'I worked at TechNova as a Backend Developer from May 2022 to Dec 2023, building REST APIs with Node.js and cutting p95 latency by 30%.',
    output_lang: 'en',
    note: 'closed range → start 05/2022, end 12/2023; metrics 30% grounded',
  },
  {
    id: 'vi-sparse',
    narrative: 'Mình từng thực tập ở một công ty fintech, chủ yếu sửa bug frontend.',
    output_lang: 'vi',
    note: 'NO company name / NO dates / NO metrics → those MUST be missing, not invented',
  },
];

function stringify(v: string | string[]): string {
  return Array.isArray(v) ? v.join(' ') : v;
}

async function main(): Promise<void> {
  const client = new OpenAI();
  const model = process.env.CV_INTAKE_MODEL || process.env.OPENAI_MODEL_DEFAULT || 'gpt-4o-mini';
  let clean = 0;
  for (const c of CASES) {
    const resp = await client.chat.completions.create({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: render({ narrative: c.narrative, output_lang: c.output_lang }) },
      ],
    });
    const parsed = JSON.parse(resp.choices[0].message.content ?? '{}') as IntakeLlmOutput;
    const ex = assembleExtraction(c.narrative, parsed);

    // No-fabrication invariant: every `found` non-date field must be grounded in the narrative.
    const leaks: string[] = [];
    for (const [k, f] of Object.entries(ex.fields)) {
      if (!f.found || k === 'start' || k === 'end') continue;
      if (!isGrounded(stringify(f.value), c.narrative)) {
        leaks.push(`${k}="${stringify(f.value)}"`);
      }
    }

    // eslint-disable-next-line no-console
    console.log(`\n[${c.id}] (${c.note})\n  ${c.narrative}`);
    for (const key of Object.keys(ex.fields)) {
      const f = ex.fields[key as keyof typeof ex.fields];
      // eslint-disable-next-line no-console
      console.log(
        `  ${key.padEnd(12)} ${f.found ? '✓' : '·'} ${JSON.stringify(f.value)}${f.source_span ? '  ⟵ "' + f.source_span + '"' : ''}`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(`  missing: ${JSON.stringify(ex.missing)}`);
    // eslint-disable-next-line no-console
    console.log(`  NO-FAB:  ${leaks.length === 0 ? 'CLEAN ✅' : 'LEAK ❌ ' + leaks.join(', ')}`);
    if (leaks.length === 0) clean += 1;
  }
  // eslint-disable-next-line no-console
  console.log(
    `\n=== ${clean}/${CASES.length} cases with zero fabrication leak (model: ${model}) ===`,
  );
}

void main();

/**
 * One-off INSPECTION (not a gate): run a spread of real-shaped JDs through the live cv_jd_match_v2
 * extraction and dump the FULL normalized jd_dimensions per JD, so we can eyeball extraction quality
 * across roles + languages without waiting for organic prod traffic.
 *
 *   pnpm exec ts-node -r tsconfig-paths/register src/calibration/inspect-jd-dimensions.ts
 *
 * Calls the real LLM (Gemini/OpenAI per .env) — billable, non-deterministic. Report-only.
 */
import * as dotenv from 'dotenv';
const dotenvParsed = dotenv.config().parsed ?? {};
if (dotenvParsed.OPENAI_API_KEY) process.env.OPENAI_API_KEY = dotenvParsed.OPENAI_API_KEY;
import { normalizeJdDimensions } from '../modules/gap-engine/jd-dimensions';
import { withRetry } from './retry';

process.env.NODE_ENV = 'test';

const PROMPT_CODE = 'cv_jd_match_v2';
const DELAY_MS = Number(process.env.EVAL_DELAY_MS ?? 3000);
const CV = 'Software engineer with experience in JavaScript, SQL and Git at a startup.';

interface JdCase {
  id: string;
  note: string;
  jd_text: string;
}

const CASES: JdCase[] = [
  {
    id: 'frontend-explicit-EN',
    note: 'explicit English + degree + years + onsite (the "rõ" case)',
    jd_text:
      "Frontend Developer (React). Required: English B2 or equivalent. Required: Bachelor's degree in Computer Science or a related field. Required: 2+ years of professional React/TypeScript experience. Build responsive UIs with React, TypeScript, Tailwind. Onsite at our District 1, Ho Chi Minh City office (no remote).",
  },
  {
    id: 'backend-EN',
    note: 'backend, 3+ yrs, microservices',
    jd_text:
      'Backend Engineer. We need 3+ years building REST APIs with Node.js and PostgreSQL. Experience with microservices, Docker, message queues and CI/CD. Nice to have: AWS, Kubernetes. Strong understanding of database design and indexing.',
  },
  {
    id: 'ai-app-rag-EN',
    note: 'AI application / RAG / LLM engineer',
    jd_text:
      'AI Application Engineer (LLM/RAG). Build retrieval-augmented generation pipelines using LangChain, vector databases (pgvector/Pinecone) and OpenAI/Gemini APIs. Strong Python. Prompt engineering and evaluation experience required. Fintech domain experience is a plus. Senior level, 4+ years in software with 1+ year on LLM apps.',
  },
  {
    id: 'mobile-EN',
    note: 'mobile, RN/Flutter',
    jd_text:
      'Mobile Developer. Develop cross-platform apps with React Native (or Flutter). Publish to the App Store and Google Play. Experience with REST integration, push notifications and offline storage. English reading comprehension for documentation.',
  },
  {
    id: 'qa-EN',
    note: 'QA, manual + automation',
    jd_text:
      'QA Engineer. Design and execute manual and automated test cases. Hands-on with Selenium or Cypress, API testing with Postman. Write clear bug reports. Junior to mid level welcome. Bachelor degree preferred.',
  },
  {
    id: 'data-analyst-EN',
    note: 'data analyst',
    jd_text:
      'Data Analyst. Strong SQL and Python (pandas). Build dashboards in Power BI or Tableau. ETL and data cleaning. Communicate insights to stakeholders. Remote-friendly within Vietnam timezone.',
  },
  {
    id: 'frontend-VI',
    note: 'Vietnamese JD with English/degree/years/onsite',
    jd_text:
      'Lập trình viên Frontend (ReactJS). Yêu cầu: Tốt nghiệp Đại học chuyên ngành Công nghệ thông tin. Yêu cầu: Tiếng Anh giao tiếp tốt (đọc hiểu tài liệu kỹ thuật). Yêu cầu: Tối thiểu 2 năm kinh nghiệm làm việc với ReactJS, TypeScript. Làm việc tại văn phòng Hà Nội. Ưu tiên ứng viên có kinh nghiệm lĩnh vực thương mại điện tử.',
  },
  {
    id: 'skills-only-no-nonskill-EN',
    note: 'NEGATIVE control: skills only, NO seniority/degree/English/onsite — must not fabricate',
    jd_text:
      'We are looking for a developer comfortable with React, Node.js, PostgreSQL and Git. You will build features end to end and collaborate with the product team.',
  },
];

async function main(): Promise<void> {
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../app.module');
  const { LlmService } = await import('../infrastructure/llm/llm.service');
  const { PromptsService } = await import('../modules/prompts/prompts.service');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const llm = app.get(LlmService);
  const prompts = app.get(PromptsService);
  const template = prompts.get(PROMPT_CODE);

  console.log(`\njd_dimensions inspection — ${CASES.length} JDs via ${PROMPT_CODE}\n`);

  for (const c of CASES) {
    const user = prompts.render(PROMPT_CODE, { cv_text: CV, jd_text: c.jd_text });
    let dims: ReturnType<typeof normalizeJdDimensions> = [];
    try {
      const res = await withRetry(
        () =>
          llm.complete(
            [
              { role: 'system', content: template.meta.system ?? '' },
              { role: 'user', content: user },
            ],
            { jsonMode: true, temperature: 0.1, maxOutputTokens: 3000 },
          ),
        2,
        (e, n) => console.warn(`  ${c.id}: retry ${n} — ${(e as Error).message}`),
      );
      const obj = (res.parsedJson && typeof res.parsedJson === 'object' ? res.parsedJson : {}) as {
        jd_dimensions_raw?: unknown;
      };
      dims = normalizeJdDimensions(obj.jd_dimensions_raw);
    } catch (e) {
      console.log(`\n### ${c.id} — ERROR: ${(e as Error).message}`);
      continue;
    }

    console.log(`\n### ${c.id}  (${c.note})`);
    if (dims.length === 0) {
      console.log('  (no jd_dimensions extracted)');
    } else {
      for (const d of dims) {
        const bits = [
          d.dimension.padEnd(10),
          (d.importance ?? '?').padEnd(12),
          d.deal_breaker ? 'DEALBREAKER' : '          ',
          d.level_hint ? `level=${d.level_hint}` : '',
          d.min_years != null ? `min_years=${d.min_years}` : '',
          `:: ${d.value_text ?? ''}`,
        ];
        console.log(`  - ${bits.filter(Boolean).join(' ')}`);
      }
    }
    if (DELAY_MS > 0) await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  await app.close();
  console.log('\n(done — inspect above for correctness / fabrication)\n');
}

main().catch((err) => {
  console.error('\ninspect-jd-dimensions failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});

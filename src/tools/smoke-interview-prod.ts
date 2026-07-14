/**
 * Interview production smoke (Wave I-MEASURE, Task 10) — boots the real Nest context and drives
 * the EXACT production interview path through InterviewsService directly (no HTTP):
 * start (ROLE_ONLY, TEXT) → 3 answer() turns → end(). Asserts non-empty questions, a turn trace
 * on every turn (Wave I-REAL), score explanations in the final report (Wave I-SCORE), and no
 * forbidden unsupported claims in engine narration (shares GLOBAL_FORBIDDEN_CLAIMS with the
 * eval:interview-production gate).
 *
 *   pnpm smoke:interview
 *
 * SAFETY: defaults to LOCAL — refuses a non-local DATABASE_URL unless SMOKE_ALLOW_PROD=1 is set
 * explicitly (on top of the repo's own local→prod DB guard chokepoints).
 * COST/QUOTA WARNING: makes real LLM calls (assess + insight per answered turn, ask per next
 * question, coaching at end) and consumes ONE interview-session entitlement for the chosen user.
 * Run deliberately — never in CI or a loop.
 */
import * as dotenv from 'dotenv';
const dotenvParsed = dotenv.config().parsed ?? {};
if (dotenvParsed.OPENAI_API_KEY) process.env.OPENAI_API_KEY = dotenvParsed.OPENAI_API_KEY;

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { DatabaseService } from '../infrastructure/database/database.service';
import { InterviewsService } from '../platform/interviews/interviews.service';
import { GLOBAL_FORBIDDEN_CLAIMS } from '../modules/interview/interview-production-eval';
import { ScoreExplanation } from '../modules/interview/interview-scoring';

// ── canned answers: one adequate, one shallow, one honest "I don't know" ───────────────────────
const ANSWERS = [
  'When our orders API started returning 500s under load, I was responsible for finding the cause. I checked the logs, reproduced it locally, and found a missing database index. I added the index and as a result p95 latency dropped from 900ms to 200ms.',
  'I have only read about query planning basics, to be honest. I usually rely on the ORM defaults.',
  'I do not know much about message queues yet — we did not cover them in my last project.',
];

const LOCAL_DB_HOSTS = ['localhost', '127.0.0.1', 'host.docker.internal'];

function assertLocalUnlessAllowed(): void {
  if (process.env.SMOKE_ALLOW_PROD === '1') return;
  const url = process.env.DATABASE_URL ?? '';
  const isLocal = LOCAL_DB_HOSTS.some((host) => url.includes(host));
  if (!isLocal) {
    throw new Error(
      'DATABASE_URL does not look local. This smoke defaults to dry-run/local; set SMOKE_ALLOW_PROD=1 to run against a non-local environment deliberately.',
    );
  }
}

function fail(failures: string[], msg: string): void {
  failures.push(msg);
  console.log(`  ✗ ${msg}`);
}

function ok(msg: string): void {
  console.log(`  ✓ ${msg}`);
}

function scanForbidden(failures: string[], where: string, text: string | null | undefined): void {
  if (!text) return;
  const lower = text.toLowerCase();
  for (const claim of GLOBAL_FORBIDDEN_CLAIMS) {
    if (lower.includes(claim.toLowerCase())) {
      fail(failures, `forbidden claim "${claim}" in ${where}`);
    }
  }
}

async function main(): Promise<void> {
  assertLocalUnlessAllowed();
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });
  const failures: string[] = [];
  try {
    const db = app.get(DatabaseService);
    const interviews = app.get(InterviewsService);

    const users = await db.query<{ id: string }>(`SELECT id FROM public.users LIMIT 1`);
    if (users.length === 0) {
      throw new Error('No user row found in DB — seed at least one user before running.');
    }
    const userId = users[0].id;
    console.log(`Using user ${userId}\n`);

    // ── start ──────────────────────────────────────────────────────────────────────────────────
    console.log('Starting interview (ROLE_ONLY / TEXT / backend_developer)...');
    const started = await interviews.start(userId, {
      targetRole: 'backend_developer',
      language: 'en',
      mode: 'TEXT',
      interviewType: 'TECHNICAL',
    });
    if (started.firstQuestion.trim()) ok(`first question: "${started.firstQuestion.slice(0, 80)}"`);
    else fail(failures, 'firstQuestion is empty');

    // ── turns ──────────────────────────────────────────────────────────────────────────────────
    let finished = false;
    for (const [index, answer] of ANSWERS.entries()) {
      if (finished) break;
      console.log(`\nAnswering turn ${index + 1}...`);
      const response = await interviews.answer(userId, {
        sessionId: started.id,
        userAnswer: answer,
        modality: 'TEXT',
        durationSeconds: 45,
      });
      finished = response.finished;

      const trace = response.turnTrace;
      if (trace && Array.isArray(trace.reasons) && trace.reasons.length > 0) {
        ok(`turn trace: action=${trace.action} reasons=[${trace.reasons.join(',')}]`);
      } else {
        fail(failures, `turn ${index + 1} has no usable turnTrace`);
      }
      if (finished) {
        ok('engine finished the session itself');
      } else if (response.nextQuestion?.trim()) {
        ok(`next question: "${response.nextQuestion.slice(0, 80)}"`);
      } else {
        fail(failures, `turn ${index + 1} produced no next question while not finished`);
      }
    }

    // ── end + final report ─────────────────────────────────────────────────────────────────────
    console.log('\nEnding session...');
    const detail = finished
      ? await interviews.get(userId, started.id)
      : await interviews.end(userId, { sessionId: started.id });

    const finalScore = detail.finalScore as {
      overall?: number;
      score_explanations?: ScoreExplanation[];
    } | null;
    const overall = finalScore?.overall;
    if (typeof overall === 'number' && overall >= 0 && overall <= 100) {
      ok(`final overall in [0,100]: ${overall}`);
    } else {
      fail(failures, `final overall missing/out of range: ${String(overall)}`);
    }

    const explanations = finalScore?.score_explanations ?? [];
    if (explanations.length > 0 && explanations.every((e) => e.rubric_anchor?.trim())) {
      ok(`score_explanations present for ${explanations.length} dimension(s)`);
    } else {
      fail(failures, 'score_explanations missing or without rubric anchors');
    }

    // forbidden claims — engine narration only (coaching, hints/anchors, gap actions).
    const coaching = detail.coaching as { summary?: string; strengths?: string[] } | null;
    scanForbidden(failures, 'coaching.summary', coaching?.summary);
    for (const e of explanations) {
      scanForbidden(failures, `explanation ${e.dimension} hint`, e.improvement_hint);
      scanForbidden(failures, `explanation ${e.dimension} anchor`, e.rubric_anchor);
    }
    const gapItems = (detail.gapItems ?? []) as Array<{ recommended_action?: string }>;
    for (const g of gapItems) {
      scanForbidden(failures, 'gap recommended_action', g.recommended_action);
    }
    if (failures.every((f) => !f.startsWith('forbidden claim'))) {
      ok('no forbidden claims in engine narration');
    }

    console.log('\n=== Summary ===');
    console.log(`Session ${started.id}: status=${detail.status} overall=${String(overall)}`);
    for (const e of explanations) {
      console.log(
        `  - ${e.dimension}: ${e.score} (${e.band}, uncertainty=${e.uncertainty})` +
          (e.evidence_quote ? ` quote="${e.evidence_quote.slice(0, 60)}..."` : ' quote=none'),
      );
    }

    if (failures.length > 0) {
      console.log(`\n${failures.length} check(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll smoke checks passed.');
    }
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(`interview smoke failed: ${(err as Error).message}`);
  process.exit(1);
});

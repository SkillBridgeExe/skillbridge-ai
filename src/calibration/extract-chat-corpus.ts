/**
 * Wave 3 (3D — regression replay): extract prod diagnosis-chat transcripts into CANDIDATE
 * corpus entries for diagnosis-chat-fabrication-gate.spec.ts.
 *
 *   pnpm corpus:extract-chat            # last 14 days
 *   DAYS=30 pnpm corpus:extract-chat
 *
 * How it reads: conversation ids come from ai_requests (request_type='diagnosis_chat') — the
 * authoritative filter, because chat_messages/chat_conversations are SHARED with learning-chat.
 * Content is already PII-masked at write time (platform maskPii), so nothing sensitive lands
 * in the output file.
 *
 * What it emits (data/eval/chat-corpus-candidates.json — LOCAL working data, do NOT commit):
 * one candidate per assistant turn, in the exact CorpusEntry field shape:
 *   { name, family: 'prod_replay', message, conversation, verdict: '?', served_shape }
 * `answer_kind` is NOT persisted, so served_shape is only an INFERENCE from the served copy
 * (refusal/canned/fallback markers). A human decides the final verdict — and any number outside
 * the spec's shared facts fixture must be licensed via the `conversation` field (INVARIANT 1)
 * or the entry rewritten against the fixture. Curation stays manual by design.
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';

// Force the real DB path (NODE_ENV=test skips TypeORM). Set BEFORE AppModule is imported.
process.env.NODE_ENV = process.env.NODE_ENV === 'test' ? 'development' : process.env.NODE_ENV;

interface MessageRow {
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

/** Shape hints only — the human curator decides the verdict. Markers mirror the served-copy
 *  families the gate/state machine can produce today; unknown copy is 'prose'. */
function servedShape(
  text: string,
): 'refusal-shaped' | 'canned-shaped' | 'fallback-shaped' | 'prose' {
  if (text.startsWith('Mình chưa đủ dữ kiện') || text.startsWith('Mình chưa có đủ dữ liệu')) {
    return 'fallback-shaped';
  }
  if (text.includes('dữ liệu đã xác minh')) return 'refusal-shaped';
  if (
    text.startsWith('Mình đang nhớ:') ||
    text.startsWith('Đã quên ') ||
    text.startsWith('Nhớ rồi nhé:') ||
    text.startsWith('Chào bạn') ||
    text.startsWith('Mình là cá heo')
  ) {
    return 'canned-shaped';
  }
  return 'prose';
}

async function main(): Promise<void> {
  const days = Math.max(1, Math.min(90, Number(process.env.DAYS) || 14));

  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../app.module');
  const { DataSource } = await import('typeorm');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const ds = app.get(DataSource);

  const rows: MessageRow[] = await ds.query(
    `SELECT m.conversation_id, m.role, m.content, m.created_at
     FROM chat_messages m
     WHERE m.conversation_id IN (
       SELECT DISTINCT (r.request_payload->>'conversation_id')::uuid
       FROM ai_requests r
       WHERE r.request_type = 'diagnosis_chat'
         AND r.created_at > NOW() - INTERVAL '${days} days'
         AND r.request_payload->>'conversation_id' IS NOT NULL
     )
     ORDER BY m.conversation_id, m.created_at ASC`,
  );

  const byConversation = new Map<string, MessageRow[]>();
  for (const row of rows) {
    const list = byConversation.get(row.conversation_id) ?? [];
    list.push(row);
    byConversation.set(row.conversation_id, list);
  }

  const candidates: Array<Record<string, string>> = [];
  let convIndex = 0;
  for (const [, turns] of byConversation) {
    convIndex += 1;
    const priorUserTurns: string[] = [];
    let turnIndex = 0;
    for (const turn of turns) {
      if (turn.role === 'user') {
        priorUserTurns.push(turn.content);
        continue;
      }
      turnIndex += 1;
      candidates.push({
        name: `prod c${convIndex} turn ${turnIndex}`,
        family: 'prod_replay',
        message: turn.content,
        conversation: priorUserTurns.join('\n'),
        verdict: '?',
        served_shape: servedShape(turn.content),
      });
    }
  }

  const outFile = path.join(process.cwd(), 'data', 'eval', 'chat-corpus-candidates.json');
  fs.writeFileSync(
    outFile,
    JSON.stringify({ extracted_days: days, count: candidates.length, candidates }, null, 2),
    'utf8',
  );
  /* eslint-disable no-console */
  console.log(`conversations: ${byConversation.size} · assistant turns: ${candidates.length}`);
  const shapeTally = candidates.reduce<Record<string, number>>(
    (a, c) => ({ ...a, [c.served_shape]: (a[c.served_shape] ?? 0) + 1 }),
    {},
  );
  console.log(
    `shapes: ${Object.entries(shapeTally)
      .map(([k, v]) => `${k} ×${v}`)
      .join(' | ')}`,
  );
  console.log(`→ ${outFile} (local working data — curate by hand, do NOT commit)`);
  /* eslint-enable no-console */
  await app.close();
}

void main().catch((err) => {
  /* eslint-disable-next-line no-console */
  console.error(err);
  process.exit(1);
});

/**
 * Manual JD import (J2 seed path) — bootstrap the jobs pool with REAL postings.
 *
 *   pnpm jobs:import data/jobs-seed.json
 *
 * Input file = JSON array of RawJobInput: paste the REAL posting's text into jd_text +
 * its canonical URL into source_url. The pipeline PII-scrubs, extracts skills, and then
 * DISCARDS the text — only skills + metadata + the link are stored (legal posture:
 * docs/jd-pool-research.md). Re-running the same file is idempotent (content-hash identity).
 *
 * Boots the real Nest application context → the EXACT production ingest path
 * (same one the J3 crawlers will call).
 */
import * as dotenv from 'dotenv';
// Same surgical override as the other tools (stale OS-level OPENAI_API_KEY gotcha).
const dotenvParsed = dotenv.config().parsed ?? {};
if (dotenvParsed.OPENAI_API_KEY) process.env.OPENAI_API_KEY = dotenvParsed.OPENAI_API_KEY;

import * as fs from 'fs';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { JdIngestService, RawJobInput } from '../modules/jobs/ingest/jd-ingest.service';

async function main(): Promise<void> {
  const fileArg = process.argv[2];
  if (!fileArg) {
    console.error('Usage: pnpm jobs:import <file.json>  (see data/jobs-seed.sample.json)');
    process.exit(1);
  }
  const filePath = path.resolve(process.cwd(), fileArg);
  const items = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as RawJobInput[];
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Input must be a non-empty JSON array of RawJobInput');
  }
  console.log(`Importing ${items.length} job(s) from ${fileArg}…`);

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });
  try {
    const ingest = app.get(JdIngestService);
    const summary = await ingest.ingestBatch(items, 'manual');
    console.log(
      `Done: fetched ${summary.fetched} · inserted ${summary.inserted} · updated ${summary.updated}` +
        ` · skipped(no skills) ${summary.skipped_no_skills} · errors ${summary.errors.length}`,
    );
    for (const e of summary.errors) console.error(`  ✗ "${e.title}": ${e.error}`);
    if (summary.skipped_no_skills > 0) {
      console.log(
        'Tip: skipped JDs name no taxonomy skill — check the text or extend aliases (taxonomy:validate gate).',
      );
    }
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(`jobs:import failed: ${(err as Error).message}`);
  process.exit(1);
});

/**
 * Run the disciplined ITviec crawl once (J3).
 *
 *   pnpm jobs:crawl            # default: up to 40 detail pages
 *   pnpm jobs:crawl 80         # custom bound
 *
 * Schedule DAILY from an EXTERNAL trigger (Render Cron Job / QStash / GitHub Actions cron).
 * Rate-limited (~1 req/4s + jitter) — a run with 40 details takes ~4-5 minutes by design.
 */
import * as dotenv from 'dotenv';
const dotenvParsed = dotenv.config().parsed ?? {};
if (dotenvParsed.OPENAI_API_KEY) process.env.OPENAI_API_KEY = dotenvParsed.OPENAI_API_KEY;

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { ItviecCrawlerService } from '../modules/jobs/crawl/itviec-crawler.service';

async function main(): Promise<void> {
  const max = process.argv[2] ? parseInt(process.argv[2], 10) : undefined;
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });
  try {
    const s = await app.get(ItviecCrawlerService).crawl(max);
    console.log(
      `Crawl done [${s.discovery}]: slugs ${s.slugsDiscovered} · refreshed ${s.refreshed}` +
        ` · details ${s.detailsFetched} · parsed ${s.parsed} · inserted ${s.ingested.inserted}` +
        ` · updated ${s.ingested.updated} · skipped ${s.ingested.skipped} · errors ${s.ingested.errors}` +
        ` · expired ${s.expired}`,
    );
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(`jobs:crawl failed: ${(err as Error).message}`);
  process.exit(1);
});

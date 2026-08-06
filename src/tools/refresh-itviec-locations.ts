/**
 * Fill structured locations for existing ITviec jobs.
 *
 *   pnpm jobs:refresh-locations -- 40          # fetch + dry-run
 *   pnpm jobs:refresh-locations -- 40 --apply  # fetch + guarded transaction
 *
 * The fetch is deliberately bounded and robots/rate-limit rules are shared with jobs:crawl.
 */
import * as dotenv from 'dotenv';

const dotenvParsed = dotenv.config().parsed ?? {};
if (dotenvParsed.OPENAI_API_KEY) process.env.OPENAI_API_KEY = dotenvParsed.OPENAI_API_KEY;

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { ItviecCrawlerService } from '../modules/jobs/crawl/itviec-crawler.service';

async function main(): Promise<void> {
  const max = process.argv.find((arg) => /^\d+$/.test(arg));
  const apply = process.argv.includes('--apply');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });
  try {
    const summary = await app
      .get(ItviecCrawlerService)
      .refreshStructuredLocations(max ? Number(max) : 40, apply);
    console.log(
      `ITviec location refresh: ${summary.candidates} candidates · ${summary.parsed} parsed · ` +
        `${summary.changes} changes · ${summary.applied} applied · ${summary.skipped} skipped · ` +
        `${summary.errors.length} errors · ${apply ? 'APPLY' : 'DRY-RUN'}`,
    );
    for (const error of summary.errors) {
      console.log(`  ERROR ${error.id} | ${error.title} | ${error.error}`);
    }
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(`jobs:refresh-locations failed: ${(error as Error).message}`);
  process.exit(1);
});

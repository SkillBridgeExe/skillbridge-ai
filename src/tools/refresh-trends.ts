/**
 * Materialize today's skill-demand snapshot (J5).
 *
 *   pnpm trends:refresh
 *
 * Schedule DAILY from an EXTERNAL trigger (Render Cron Job / QStash / GitHub Actions cron) —
 * in-process @Cron is deliberately not used: the Render free instance sleeps and an in-app
 * scheduler silently never fires. Idempotent within a day (UPSERT on skill/role/period).
 */
import * as dotenv from 'dotenv';
const dotenvParsed = dotenv.config().parsed ?? {};
if (dotenvParsed.OPENAI_API_KEY) process.env.OPENAI_API_KEY = dotenvParsed.OPENAI_API_KEY;

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { SkillDemandService } from '../modules/jobs/trends/skill-demand.service';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });
  try {
    const written = await app.get(SkillDemandService).refreshSnapshots();
    console.log(`Snapshot refreshed: ${written} (skill × role) rows for today.`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(`trends:refresh failed: ${(err as Error).message}`);
  process.exit(1);
});

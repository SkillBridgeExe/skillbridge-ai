/**
 * MEASURE M3 — impact calibration reader. impact_calibrations has been write-only since ME2:
 * every scan-N recommended_action writes its predicted impact, and scan-N+1 fills in what
 * actually happened. This tool finally reads it back: predicted vs actual, grouped by
 * (action_type, skill), as a markdown report for tuning the impact simulator.
 *
 *   pnpm calibration:report            # prints markdown to stdout
 *
 * Read-only (one SELECT). Needs DATABASE_URL — run via Cloud Run Job or an operator shell
 * (local runs against prod are blocked by the prod-db guard unless ALLOW_PROD_DB=1).
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { DatabaseService } from '../infrastructure/database/database.service';
import {
  aggregateImpactCalibrations,
  renderImpactCalibrationMarkdown,
  ImpactCalibrationRow,
} from './lib/impact-calibration-report';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });
  try {
    const db = app.get(DatabaseService);
    const rows = await db.query<ImpactCalibrationRow>(
      `SELECT canonical_name, action_type,
              predicted_score_min::text AS predicted_score_min,
              predicted_score_max::text AS predicted_score_max,
              actual_score_delta::text AS actual_score_delta,
              status_transition, attempted
         FROM public.impact_calibrations`,
    );
    console.log(renderImpactCalibrationMarkdown(aggregateImpactCalibrations(rows)));
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(`impact calibration report failed: ${(err as Error).message}`);
  process.exit(1);
});

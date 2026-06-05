/**
 * Ops smoke for J4 job recommendations — boots the real Nest context and runs the EXACT
 * production path: CV skills → SkillDiff (MATCH_TUNING) + CV-embedding cosine → RRF → top N.
 *
 *   pnpm reco:smoke            # auto-picks the CV with the most persisted skills
 *   pnpm reco:smoke <cvId>     # specific CV
 *
 * Run after seeding jobs (jobs:import) or backfills. Cost: 1 embedding call per run.
 */
import * as dotenv from 'dotenv';
const dotenvParsed = dotenv.config().parsed ?? {};
if (dotenvParsed.OPENAI_API_KEY) process.env.OPENAI_API_KEY = dotenvParsed.OPENAI_API_KEY;

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { DatabaseService } from '../infrastructure/database/database.service';
import { JobRecommendationService } from '../modules/jobs/reco/job-recommendation.service';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });
  try {
    const db = app.get(DatabaseService);
    const reco = app.get(JobRecommendationService);

    let cvId = process.argv[2];
    let userId: string;
    if (cvId) {
      const rows = await db.query<{ user_id: string }>(
        `SELECT user_id FROM public.cvs WHERE id = $1 AND deleted_at IS NULL`,
        [cvId],
      );
      if (rows.length === 0) throw new Error(`CV ${cvId} not found`);
      userId = rows[0].user_id;
    } else {
      const rows = await db.query<{ cv_id: string; user_id: string; n: string }>(
        `SELECT cs.cv_id, c.user_id, count(*)::text AS n
           FROM public.cv_skills cs JOIN public.cvs c ON c.id = cs.cv_id AND c.deleted_at IS NULL
          GROUP BY cs.cv_id, c.user_id ORDER BY count(*) DESC LIMIT 1`,
      );
      if (rows.length === 0)
        throw new Error('No CV with persisted skills found — run a CV review first.');
      cvId = rows[0].cv_id;
      userId = rows[0].user_id;
      console.log(`Auto-picked CV ${cvId} (${rows[0].n} skills)`);
    }

    const result = await reco.recommendForCv(userId, cvId, { limit: 5 });
    console.log(
      `Pool: ${result.pool_size} active jobs · ${result.recommendations.length} recommendations\n`,
    );
    for (const r of result.recommendations) {
      console.log(
        `#${r.rank} [${r.match_score}] ${r.title} — ${r.company_name} (${r.location ?? '?'})` +
          `\n    sim=${r.semantic_similarity ?? '—'} · matched: ${r.matched_skills.join(', ') || '—'}` +
          `\n    missing: ${r.missing_skills.map((m) => `${m.display_name}(${m.importance})`).join(', ') || '—'}`,
      );
    }
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(`reco smoke failed: ${(err as Error).message}`);
  process.exit(1);
});

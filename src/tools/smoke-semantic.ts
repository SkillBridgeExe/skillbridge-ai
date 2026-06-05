/**
 * Ops smoke test for the semantic skill tier — boots the REAL Nest application context and
 * runs a handful of phrases through SkillNormalizerService.normalizeMentionAsync, i.e. the
 * exact production path: DI → isEnabled gate → skill_resolutions cache → OpenAI embed →
 * pgvector top-1 → 3-band gate → cache write.
 *
 *   pnpm semantic:smoke                     # default probe set
 *   pnpm semantic:smoke "phrase 1" "câu 2"  # custom phrases
 *
 * Verifies in one shot: OPENAI_API_KEY valid · DATABASE_URL reachable · skill_embeddings
 * matrix present for the configured tuple · thresholds wired. Run after any backfill,
 * threshold change, or embedding_version bump. Cost: ≤1 embedding call per UNCACHED phrase.
 */
import * as dotenv from 'dotenv';
// Same surgical override as the backfill (stale OS-level OPENAI_API_KEY gotcha).
const dotenvParsed = dotenv.config().parsed ?? {};
if (dotenvParsed.OPENAI_API_KEY) process.env.OPENAI_API_KEY = dotenvParsed.OPENAI_API_KEY;

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { SkillNormalizerService } from '../common/services/skill-normalizer.service';
import { SemanticSkillMatcherService } from '../common/services/semantic-skill-matcher.service';

const DEFAULT_PROBES = [
  'continuous delivery pipelines', // semantic candidate (EN, near ci_cd)
  'truy vấn dữ liệu', // semantic candidate (VI, near sql)
  'quản lý nhân sự', // adversarial negative — MUST stay unresolved
  'React', // deterministic exact — must NOT touch the semantic tier
];

async function main(): Promise<void> {
  const phrases = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_PROBES;

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });
  try {
    const normalizer = app.get(SkillNormalizerService);
    const matcher = app.get(SemanticSkillMatcherService);
    console.log(`semantic tier enabled: ${matcher.isEnabled()}`);

    for (const phrase of phrases) {
      const results = await normalizer.normalizeMentionAsync(phrase);
      if (results.length === 0) {
        console.log(`  "${phrase}" → (unresolved)`);
        continue;
      }
      for (const r of results) {
        console.log(
          `  "${phrase}" → ${r.canonical_name} [${r.matched_via}, conf=${r.confidence.toFixed(2)}]`,
        );
      }
    }
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(`smoke failed: ${(err as Error).message}`);
  process.exit(1);
});

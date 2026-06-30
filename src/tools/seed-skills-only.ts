/**
 * One-off: seed ONLY the `public.skills` table from data/skills-pilot.json.
 *
 * Mirrors seedSkills() in src/database/seed.ts EXACTLY (additive + idempotent:
 * existing canonicals are left untouched, only new rows inserted). Unlike
 * `pnpm seed` it does NOT touch users/accounts/mentor-profiles/question-bank —
 * safe to run against prod purely to register new taxonomy skills before
 * `pnpm embeddings:backfill` (whose FK guard requires every canonical to exist
 * in public.skills first).
 *
 *   ts-node -r tsconfig-paths/register src/tools/seed-skills-only.ts
 *
 * Env: DATABASE_URL required (via .env / data-source).
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import dataSource from '../database/data-source';
import { SkillEntity } from '../database/entities/skill.entity';

interface SkillSeed {
  canonical_name: string;
  display_name: string;
  category?: string | null;
  source?: string | null;
  source_external_id?: string | null;
  aliases?: string[];
  in_demand?: boolean;
}

function loadSkillSeeds(): SkillSeed[] {
  const filePath = path.join(process.cwd(), 'data', 'skills-pilot.json');
  const raw = fs.readFileSync(filePath, 'utf-8');
  const json = JSON.parse(raw) as { skills?: SkillSeed[] };
  return json.skills ?? [];
}

async function main(): Promise<void> {
  await dataSource.initialize();
  const skills = dataSource.getRepository(SkillEntity);
  const seeds = loadSkillSeeds();

  let inserted = 0;
  let skipped = 0;
  const newCanonicals: string[] = [];

  for (const seed of seeds) {
    const existing = await skills.findOne({ where: { canonicalName: seed.canonical_name } });
    if (existing) {
      skipped++;
      continue;
    }
    await skills.save(
      skills.create({
        canonicalName: seed.canonical_name,
        displayName: seed.display_name,
        category: seed.category ?? null,
        source: seed.source ?? null,
        sourceExternalId: seed.source_external_id ?? null,
        aliases: seed.aliases ?? [],
        inDemand: seed.in_demand ?? false,
      }),
    );
    inserted++;
    newCanonicals.push(seed.canonical_name);
  }

  console.log(
    `skills-only seed: ${seeds.length} taxonomy entries → ${inserted} inserted, ${skipped} already present.`,
  );
  if (newCanonicals.length) console.log(`Inserted: ${newCanonicals.join(', ')}`);
  await dataSource.destroy();
}

main().catch((err) => {
  console.error('seed-skills-only failed:', err);
  process.exit(1);
});

/**
 * Task 8b + Task 6 — sync data/skills-pilot.json into public.skills (the explicit UPDATE path
 * that seed.ts lacks), then derive `in_demand` from the real job pool.
 *   pnpm exec ts-node src/tools/sync-skills-to-db.ts
 *
 * - Upsert every pilot skill by canonical_name (INSERT new; UPDATE display/category/source/
 *   source_external_id/aliases/in_demand on existing). Skills NOT in the pilot (e.g. the 9
 *   marketing rows) are left untouched.
 * - Then in_demand = true for skills appearing in >= IN_DEMAND_MIN_JOBS job_skills rows
 *   (VN-market signal) UNIONed with the O*NET-hot flag already set from the pilot.
 * Run AFTER the in_demand migration and BEFORE embeddings:backfill (which needs canonicals in DB).
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import dataSource from '../database/data-source';
import { SkillEntity } from '../database/entities/skill.entity';

interface PilotSkill {
  canonical_name: string;
  display_name: string;
  category?: string | null;
  source?: string | null;
  source_external_id?: string | null;
  aliases?: string[];
  in_demand?: boolean;
}

const IN_DEMAND_MIN_JOBS = parseInt(process.env.IN_DEMAND_MIN_JOBS ?? '30', 10);

async function main(): Promise<void> {
  const file = path.join(process.cwd(), 'data', 'skills-pilot.json');
  const pilot = (JSON.parse(fs.readFileSync(file, 'utf8')) as { skills: PilotSkill[] }).skills;

  await dataSource.initialize();
  const repo = dataSource.getRepository(SkillEntity);

  let inserted = 0;
  let updated = 0;
  for (const s of pilot) {
    const fields = {
      displayName: s.display_name,
      category: s.category ?? null,
      source: s.source ?? null,
      sourceExternalId: s.source_external_id ?? null,
      aliases: s.aliases ?? [],
      inDemand: s.in_demand ?? false,
    };
    const existing = await repo.findOne({ where: { canonicalName: s.canonical_name } });
    if (existing) {
      await repo.update(existing.id, fields);
      updated++;
    } else {
      await repo.save(repo.create({ canonicalName: s.canonical_name, ...fields }));
      inserted++;
    }
  }

  // Task 6 — derive in_demand AUTHORITATIVELY from the job pool (VN-market signal): true iff the
  // skill appears in >= IN_DEMAND_MIN_JOBS job_skills rows. Re-derivable (overrides prior value).
  await dataSource.query(
    `UPDATE public.skills SET in_demand = (id IN (
       SELECT skill_id FROM public.job_skills GROUP BY skill_id HAVING count(*) >= $1
     ))`,
    [IN_DEMAND_MIN_JOBS],
  );
  const demandTotal = await dataSource.query(`SELECT count(*)::int n FROM public.skills WHERE in_demand = true`);

  console.log(`sync: inserted ${inserted}, updated ${updated}, pilot ${pilot.length}`);
  console.log(`in_demand (>=${IN_DEMAND_MIN_JOBS} jobs): total=${demandTotal[0].n}`);
  await dataSource.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

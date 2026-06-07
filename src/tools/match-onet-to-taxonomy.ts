/**
 * Task 4/5 helper — classify O*NET hot-technology tools against the EXISTING taxonomy.
 *   NODE_ENV=test pnpm exec ts-node src/tools/match-onet-to-taxonomy.ts
 * Sync SkillNormalizer cascade (exact/alias/fuzzy; no DB/embeddings/key under NODE_ENV=test).
 * Splits hot tools into aliasable (already known -> attach O*NET id+alias) vs novel (new-row candidate).
 */
import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { SkillNormalizerService } from '../common/services/skill-normalizer.service';

interface OnetSkill {
  display_name: string;
  canonical_name: string;
  source_external_id: string;
  category: string;
  in_demand: boolean;
}

async function main(): Promise<void> {
  const file = path.join(process.cwd(), 'data', 'onet', 'onet-it-skills.json');
  const onet = JSON.parse(fs.readFileSync(file, 'utf8')) as OnetSkill[];
  const hot = onet.filter((x) => x.in_demand);
  const ctx = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const normalizer = ctx.get(SkillNormalizerService, { strict: false });
  const aliasable: Array<{ onet_name: string; onet_id: string; matched: string; via: string }> = [];
  const novel: Array<{
    onet_canonical: string;
    onet_name: string;
    onet_id: string;
    category: string;
  }> = [];
  for (const t of hot) {
    const out = normalizer.normalizeMany([t.display_name]);
    const m = out.find((r) => r.matched_via !== 'none' && r.canonical_name);
    if (m)
      aliasable.push({
        onet_name: t.display_name,
        onet_id: t.source_external_id,
        matched: m.canonical_name as string,
        via: m.matched_via,
      });
    else
      novel.push({
        onet_canonical: t.canonical_name,
        onet_name: t.display_name,
        onet_id: t.source_external_id,
        category: t.category,
      });
  }
  fs.writeFileSync(
    path.join(process.cwd(), 'data', 'onet', 'onet-match-report.json'),
    JSON.stringify({ hot: hot.length, aliasable, novel }, null, 2),
  );
  console.log(
    'HOT=' + hot.length + '  ALIAS->existing=' + aliasable.length + '  NOVEL=' + novel.length,
  );
  console.log(
    'ALIASABLE: ' +
      aliasable.map((a) => a.onet_name + '->' + a.matched + '[' + a.via + ']').join(' | '),
  );
  console.log('NOVEL: ' + novel.map((n) => n.onet_canonical).join(', '));
  await ctx.close();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

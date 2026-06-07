/**
 * Task 5 + Task 3 prep (Phase 1b) — classify ESCO digital skills against the live taxonomy.
 *   pnpm exec ts-node -r tsconfig-paths/register src/tools/match-esco-to-taxonomy.ts
 *
 * Runs every ESCO row (preferredLabel, then its aliases) through SkillNormalizerService.
 * Splits the digital subset into:
 *   - MATCHED  → already an existing canonical/alias → provenance source for Task 5
 *               (existing canonical ⇐ ESCO conceptUri). Strongest match per canonical wins.
 *   - NOVEL    → no match → candidate NEW canonical (Task 3), kept separate by skillType so
 *               the curator can prefer concrete `knowledge` concepts over prose-risky
 *               `skill/competence` verb-phrases.
 * Writes data/esco/esco-match-report.json. No mutation — read-only classification.
 */
import * as fs from 'fs';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { SkillNormalizerService } from '../common/services/skill-normalizer.service';
import type { EscoRow } from './lib/taxonomy-import';

const CONF_RANK: Record<string, number> = { exact: 4, alias: 3, fuzzy: 2, semantic: 1 };

async function main(): Promise<void> {
  const dir = path.join(process.cwd(), 'data', 'esco');
  const rows = JSON.parse(
    fs.readFileSync(path.join(dir, 'esco-it-skills.json'), 'utf-8'),
  ) as EscoRow[];

  process.env.NODE_ENV = 'test';
  const ctx = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const normalizer = ctx.get(SkillNormalizerService, { strict: false });

  // existing canonical -> best ESCO provenance (highest match rank, exact preferred).
  const provenance = new Map<
    string,
    { esco_uri: string; esco_label: string; via: string; rank: number }
  >();
  const novelKnowledge: Array<{
    canonical: string;
    label: string;
    uri: string;
    aliases: string[];
  }> = [];
  const novelCompetence: Array<{ canonical: string; label: string; uri: string }> = [];

  for (const r of rows) {
    // Try the preferredLabel first, then fall back to each alias — first real hit wins.
    const candidates = [r.preferredLabel, ...r.aliases];
    let hit: { canonical: string; via: string } | null = null;
    for (const c of candidates) {
      const out = normalizer.normalizeMany([c]);
      const m = out.find((x) => x.matched_via !== 'none' && x.canonical_name);
      if (m) {
        hit = { canonical: m.canonical_name as string, via: m.matched_via };
        break;
      }
    }

    if (hit) {
      const rank = CONF_RANK[hit.via] ?? 0;
      const prev = provenance.get(hit.canonical);
      if (!prev || rank > prev.rank) {
        provenance.set(hit.canonical, {
          esco_uri: r.conceptUri,
          esco_label: r.preferredLabel,
          via: hit.via,
          rank,
        });
      }
    } else if (r.skillType === 'knowledge') {
      novelKnowledge.push({
        canonical: r.canonical_name,
        label: r.preferredLabel,
        uri: r.conceptUri,
        aliases: r.aliases,
      });
    } else {
      novelCompetence.push({
        canonical: r.canonical_name,
        label: r.preferredLabel,
        uri: r.conceptUri,
      });
    }
  }

  const report = {
    total: rows.length,
    matched: provenance.size,
    novel_knowledge: novelKnowledge.length,
    novel_competence: novelCompetence.length,
    provenance: Object.fromEntries(
      [...provenance.entries()].map(([k, v]) => [
        k,
        { esco_uri: v.esco_uri, esco_label: v.esco_label, via: v.via },
      ]),
    ),
    novelKnowledge: novelKnowledge.sort((a, b) => a.label.localeCompare(b.label)),
    novelCompetence: novelCompetence.sort((a, b) => a.label.localeCompare(b.label)),
  };
  fs.writeFileSync(
    path.join(dir, 'esco-match-report.json'),
    JSON.stringify(report, null, 2) + '\n',
  );

  console.log(
    `ESCO=${rows.length}  MATCHED->existing=${provenance.size}  NOVEL knowledge=${novelKnowledge.length}  competence=${novelCompetence.length}`,
  );
  console.log('\nNOVEL knowledge (curate from these):');
  console.log('  ' + novelKnowledge.map((n) => n.label).join(' | '));
  await ctx.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

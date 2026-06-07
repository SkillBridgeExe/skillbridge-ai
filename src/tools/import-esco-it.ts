/**
 * Task 3 (Phase 1b) — ESCO digital-skills IT-subset importer.
 *   pnpm import:esco
 *
 * Reads the vendored ESCO v1.2.x English CSVs from `data/esco/` (gitignored —
 * see .gitignore; CC-BY, re-downloadable from https://esco.ec.europa.eu/en/use-esco/download),
 * keeps the Digital Skills collection subset of `skills_en.csv`, and emits the DERIVED
 * `data/esco/esco-it-skills.json` (committed). No DB writes, no taxonomy mutation — the
 * curation step (apply-esco-curation) decides which rows become new canonicals vs aliases.
 *
 * Prints a skillType breakdown so the curator can see how many are concrete `knowledge`
 * concepts (good canonical candidates) vs `skill/competence` verb-phrases (prose-risky).
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseEscoDigitalUris, parseEscoSkills } from './lib/taxonomy-import';

function main(): void {
  const dir = path.join(process.cwd(), 'data', 'esco');
  const digitalCsv = fs.readFileSync(path.join(dir, 'digitalSkillsCollection_en.csv'), 'utf-8');
  const skillsCsv = fs.readFileSync(path.join(dir, 'skills_en.csv'), 'utf-8');

  const digitalUris = parseEscoDigitalUris(digitalCsv);
  const rows = parseEscoSkills(skillsCsv, digitalUris);

  const outPath = path.join(dir, 'esco-it-skills.json');
  fs.writeFileSync(outPath, JSON.stringify(rows, null, 2) + '\n');

  const byType: Record<string, number> = {};
  for (const r of rows) byType[r.skillType] = (byType[r.skillType] ?? 0) + 1;

  console.log(`ESCO digital URIs: ${digitalUris.size}`);
  console.log(`ESCO digital skills (KnowledgeSkillCompetence): ${rows.length}`);
  console.log(`by skillType: ${JSON.stringify(byType)}`);
  console.log(`wrote ${outPath}`);
}

main();

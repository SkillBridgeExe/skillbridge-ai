/**
 * O*NET Technology/Software Skills → IT-subset importer (Taxonomy v2, Task 2).
 *
 *   pnpm import:onet            # reads the vendored O*NET text file under data/onet/
 *   pnpm import:onet <path>     # or point at a specific Technology/Software Skills .txt
 *
 * Reads the tab-delimited O*NET skills file, filters to the IT/software-
 * engineering subset, dedupes by tool name (see `parseOnetTechSkills`), and
 * writes `data/onet/onet-it-skills.json` — an array of seed fragments shaped
 * like `data/skills-pilot.json` entries (consumed later by Task 4's merge tool).
 *
 * Offline after a one-time download. No DB, no migration, no OpenAI/Gemini keys.
 *
 * --- O*NET version note ---------------------------------------------------
 * The plan was written against the pre-30 "Technology Skills.txt" (7 cols incl.
 * UNSPSC Commodity Code/Title). O*NET 30.x renamed this to "Software Skills.txt"
 * with columns: O*NET-SOC Code | Workplace Example | Element ID | Element Name |
 * Hot Technology | In Demand. `parseOnetTechSkills` is schema-tolerant and reads
 * either layout; this tool just locates whichever file the vendored DB ships.
 *
 * Data license: O*NET database is published by the U.S. Department of Labor,
 * Employment and Training Administration (USDOL/ETA) under CC BY 4.0. O*NET® is
 * a trademark of USDOL/ETA. Derived data here is a filtered/transformed subset.
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseOnetTechSkills, snakeCaseSkill } from './lib/taxonomy-import';

/** Candidate filenames across O*NET versions (newest naming first). */
const ONET_FILE_CANDIDATES = ['Software Skills.txt', 'Technology Skills.txt'];

/** Search roots under data/onet/ for the vendored text file. */
function resolveOnetFile(explicit?: string): string {
  if (explicit) {
    const p = path.resolve(process.cwd(), explicit);
    if (!fs.existsSync(p)) throw new Error(`O*NET file not found: ${p}`);
    return p;
  }
  const onetDir = path.join(process.cwd(), 'data', 'onet');
  if (!fs.existsSync(onetDir)) {
    throw new Error(
      `data/onet/ not found. Download + unzip the O*NET text DB there first ` +
        `(e.g. db_30_3_text.zip from https://www.onetcenter.org/database.html).`,
    );
  }
  // Walk data/onet/ (one level of subdirs is enough for the standard zip layout).
  const candidates: string[] = [];
  const scan = (dir: string, depth: number): void => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory() && depth > 0) {
        scan(full, depth - 1);
      } else if (ONET_FILE_CANDIDATES.includes(name)) {
        candidates.push(full);
      }
    }
  };
  scan(onetDir, 2);
  if (candidates.length === 0) {
    throw new Error(
      `No O*NET skills file (${ONET_FILE_CANDIDATES.join(' / ')}) found under ${onetDir}. ` +
        `Unzip the O*NET text DB there.`,
    );
  }
  return candidates[0];
}

interface SeedFragment {
  canonical_name: string;
  display_name: string;
  category: string;
  source: 'ONET';
  source_external_id: string;
  in_demand: boolean;
  aliases: string[];
}

function main(): void {
  const explicit = process.argv[2];
  const filePath = resolveOnetFile(explicit);
  const tsv = fs.readFileSync(filePath, 'utf-8');

  const rows = parseOnetTechSkills(tsv);

  const fragments: SeedFragment[] = rows.map((r) => ({
    canonical_name: snakeCaseSkill(r.example),
    display_name: r.example,
    category: r.commodityTitle,
    source: 'ONET',
    source_external_id: r.sourceExternalId,
    in_demand: r.hotTechnology,
    aliases: [],
  }));

  // Guard against snake_case collisions producing duplicate canonical_names
  // (e.g. "Node.js" vs "Node JS"). Keep the first, but surface the count so the
  // Task 4 merge step can dedupe knowingly.
  const seen = new Set<string>();
  const deduped: SeedFragment[] = [];
  let collisions = 0;
  for (const f of fragments) {
    if (!f.canonical_name) continue; // drop names that snake_case to empty
    if (seen.has(f.canonical_name)) {
      collisions++;
      continue;
    }
    seen.add(f.canonical_name);
    deduped.push(f);
  }
  deduped.sort((a, b) => a.canonical_name.localeCompare(b.canonical_name));

  const outDir = path.join(process.cwd(), 'data', 'onet');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'onet-it-skills.json');
  fs.writeFileSync(outPath, JSON.stringify(deduped, null, 2) + '\n', 'utf-8');

  const hot = deduped.filter((f) => f.in_demand).length;
  console.log(`O*NET source file: ${path.relative(process.cwd(), filePath)}`);
  console.log(`Extracted ${deduped.length} IT tools (deduped by canonical_name).`);
  console.log(`  hot_technology (in_demand=true): ${hot}`);
  console.log(`  snake_case collisions dropped:   ${collisions}`);
  console.log(`Wrote ${path.relative(process.cwd(), outPath)}`);
}

main();

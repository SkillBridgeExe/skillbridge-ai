/**
 * Unnormalized raw-skill coverage report. Reads a committed corpus of raw skill strings, runs the
 * deterministic normalizer DB-less, and prints a FREQUENCY-RANKED list of strings that fail to
 * normalize — the curation input for expanding taxonomy aliases (Component 1).
 *
 *   pnpm report:unnormalized                                  # default corpus: data/eval-mentions.json
 *   pnpm report:unnormalized -- --corpus data/my-skills.json  # JSON { "skills": string[] } or { "mentions": [{mention}] }
 *   pnpm report:unnormalized -- --corpus=raw.txt              # newline-delimited .txt
 *
 * Report, NOT a gate (exit 0 on success). Committed corpora ONLY — no DB, no ai_results read,
 * AI-lane. PII-safe: skill strings only.
 */
import * as fs from 'fs';
import * as path from 'path';
import { SkillTaxonomyService } from '../common/services/skill-taxonomy.service';
import { SkillNormalizerService } from '../common/services/skill-normalizer.service';

/** Tolerant of both `--corpus X` and `--corpus=X`. */
function parseCorpusArg(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--corpus') return argv[i + 1] ?? null;
    if (a.startsWith('--corpus=')) return a.slice('--corpus='.length);
  }
  return null;
}

function loadCorpus(corpusPath: string | null): string[] {
  if (!corpusPath) {
    const file = path.join(process.cwd(), 'data', 'eval-mentions.json');
    const { mentions } = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      mentions: Array<{ mention: string }>;
    };
    return mentions.map((m) => m.mention);
  }
  const abs = path.isAbsolute(corpusPath) ? corpusPath : path.join(process.cwd(), corpusPath);
  const raw = fs.readFileSync(abs, 'utf-8');
  if (abs.endsWith('.json')) {
    const parsed = JSON.parse(raw) as { skills?: string[]; mentions?: Array<{ mention: string }> };
    if (Array.isArray(parsed.skills)) return parsed.skills;
    if (Array.isArray(parsed.mentions)) return parsed.mentions.map((m) => m.mention);
    throw new Error(`Corpus JSON ${abs} must have "skills": string[] or "mentions": [{mention}]`);
  }
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main(): Promise<void> {
  const corpusPath = parseCorpusArg(process.argv.slice(2));
  const corpus = loadCorpus(corpusPath);

  const taxonomy = new SkillTaxonomyService();
  await taxonomy.onModuleInit();
  const normalizer = new SkillNormalizerService(taxonomy);

  // Unresolved = the full cascade yields no non-null canonical (matches eval-mentions' predict).
  const resolves = (rawName: string): boolean =>
    normalizer.normalizeMention(rawName).some((n) => n.canonical_name !== null);

  const freq = new Map<string, number>();
  let scanned = 0;
  for (const rawName of corpus) {
    const trimmed = rawName.trim();
    if (!trimmed) continue;
    scanned += 1;
    if (!resolves(trimmed)) {
      const key = trimmed.toLowerCase();
      freq.set(key, (freq.get(key) ?? 0) + 1);
    }
  }

  const ranked = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  console.log(
    `\nUnnormalized raw-skill report — corpus: ${corpusPath ?? 'data/eval-mentions.json (default)'}\n`,
  );
  console.log(`  ${scanned} raw strings · ${ranked.length} distinct unresolved\n`);
  if (ranked.length === 0) {
    console.log('  (everything resolved — no taxonomy gaps in this corpus)');
  } else {
    console.log('  count  raw_string');
    console.log('  -----  ----------');
    for (const [rawName, count] of ranked) {
      console.log(`  ${String(count).padStart(5)}  ${rawName}`);
    }
  }
  console.log(
    '\n(Drives taxonomy/alias curation. Committed corpora only — no DB, no ai_results, AI-lane.)\n',
  );
}

main().catch((err) => {
  console.error('\nreport-unnormalized failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});

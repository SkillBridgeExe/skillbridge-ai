/**
 * Unnormalized raw-skill coverage report. Reads a committed corpus of raw skill strings, runs the
 * deterministic normalizer DB-less, and prints a FREQUENCY-RANKED list of strings that fail to
 * normalize — the curation input for expanding taxonomy aliases (Component 1).
 *
 *   pnpm report:unnormalized                                  # default corpus: data/eval-mentions.json POSITIVE rows
 *   pnpm report:unnormalized -- --include-negatives           # also audit the negative-control rows (expected=[])
 *   pnpm report:unnormalized -- --corpus data/my-skills.json  # JSON { "skills": string[] } or { "mentions": [{mention}] }
 *   pnpm report:unnormalized -- --corpus=raw.txt              # newline-delimited .txt
 *
 * On the DEFAULT corpus (eval-mentions.json), rows with `expected: []` are NEGATIVE CONTROLS — they
 * are SUPPOSED to stay unresolved, so listing them as "alias gaps to fill" would be misleading.
 * They are skipped unless `--include-negatives` is passed.
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

interface Corpus {
  strings: string[];
  mode: string;
}

function loadCorpus(corpusPath: string | null, includeNegatives: boolean): Corpus {
  if (!corpusPath) {
    const file = path.join(process.cwd(), 'data', 'eval-mentions.json');
    const { mentions } = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      mentions: Array<{ mention: string; expected?: string[] }>;
    };
    // expected=[] rows are negative controls (intentionally unresolved) — skip unless audited.
    const rows = includeNegatives
      ? mentions
      : mentions.filter((m) => (m.expected?.length ?? 0) > 0);
    return {
      strings: rows.map((m) => m.mention),
      mode: includeNegatives
        ? 'data/eval-mentions.json (positive + negative-control rows)'
        : 'data/eval-mentions.json (positive rows only — negative controls skipped; --include-negatives to audit)',
    };
  }
  const abs = path.isAbsolute(corpusPath) ? corpusPath : path.join(process.cwd(), corpusPath);
  const raw = fs.readFileSync(abs, 'utf-8');
  if (abs.endsWith('.json')) {
    const parsed = JSON.parse(raw) as { skills?: string[]; mentions?: Array<{ mention: string }> };
    const strings = Array.isArray(parsed.skills)
      ? parsed.skills
      : Array.isArray(parsed.mentions)
        ? parsed.mentions.map((m) => m.mention)
        : null;
    if (!strings) {
      throw new Error(`Corpus JSON ${abs} must have "skills": string[] or "mentions": [{mention}]`);
    }
    return { strings, mode: `${corpusPath} (custom corpus — all rows)` };
  }
  return {
    strings: raw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean),
    mode: `${corpusPath} (custom corpus — all rows)`,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const corpusPath = parseCorpusArg(argv);
  const includeNegatives = argv.includes('--include-negatives');
  const { strings, mode } = loadCorpus(corpusPath, includeNegatives);

  const taxonomy = new SkillTaxonomyService();
  await taxonomy.onModuleInit();
  const normalizer = new SkillNormalizerService(taxonomy);

  // Unresolved = the full cascade yields no non-null canonical (matches eval-mentions' predict).
  const resolves = (rawName: string): boolean =>
    normalizer.normalizeMention(rawName).some((n) => n.canonical_name !== null);

  const freq = new Map<string, number>();
  let scanned = 0;
  for (const rawName of strings) {
    const trimmed = rawName.trim();
    if (!trimmed) continue;
    scanned += 1;
    if (!resolves(trimmed)) {
      const key = trimmed.toLowerCase();
      freq.set(key, (freq.get(key) ?? 0) + 1);
    }
  }

  const ranked = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  console.log(`\nUnnormalized raw-skill report — corpus: ${mode}\n`);
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

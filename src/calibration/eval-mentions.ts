/**
 * R2 eval harness #1 — skill-mention NORMALIZATION quality. Fully OFFLINE (no LLM, no DB):
 * instantiates the fs-backed taxonomy + normalizer directly, so it runs in milliseconds and
 * costs nothing. This is the GATE for every normalization/taxonomy change (blueprint §5).
 *
 *   pnpm eval:mentions                      # report + label-sanity gate
 *   EVAL_MENTIONS_STRICT=1 pnpm eval:mentions   # ALSO enforce the final bars (precision/F1)
 *
 * data/eval-mentions.json rows: { mention, lang, expected[], category, requires[], note? }
 *   - requires=[]            → the CURRENT cascade must already resolve it (label sanity).
 *   - requires=['alias']     → unlocked by step 2/3 (add alias to an existing skill).
 *   - requires=['new_skill'] → unlocked by step 3 (taxonomy expansion).
 *   - requires=['prenormalize'] → unlocked by step 4 (stage-0: versions/abbrev/compounds).
 * The harness therefore double-checks the DATASET itself: a requires=[] row that fails, or a
 * locked row that already passes, is a labeling error and fails the run.
 *
 * Bars (strict mode, post step-2..4 target): precision ≥ 0.90, F1 ≥ 0.75 (blueprint §5).
 */
import * as fs from 'fs';
import * as path from 'path';
import { SkillTaxonomyService } from '../common/services/skill-taxonomy.service';
import { SkillNormalizerService } from '../common/services/skill-normalizer.service';

type RequiresTag = 'alias' | 'new_skill' | 'prenormalize';

interface MentionRow {
  mention: string;
  lang: 'en' | 'vi' | 'mixed';
  expected: string[];
  category: string;
  requires: RequiresTag[];
  note?: string;
}

const STRICT = process.env.EVAL_MENTIONS_STRICT === '1';
const PRECISION_BAR = Number(process.env.EVAL_MENTIONS_PRECISION ?? 0.9);
const F1_BAR = Number(process.env.EVAL_MENTIONS_F1 ?? 0.75);

const setEq = (a: string[], b: string[]): boolean =>
  a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');

const pct = (n: number, d: number): string => (d === 0 ? '—' : `${Math.round((n / d) * 100)}%`);

async function main(): Promise<void> {
  const file = path.join(process.cwd(), 'data', 'eval-mentions.json');
  const { mentions } = JSON.parse(fs.readFileSync(file, 'utf-8')) as { mentions: MentionRow[] };

  const taxonomy = new SkillTaxonomyService();
  await taxonomy.onModuleInit();
  const normalizer = new SkillNormalizerService(taxonomy);

  /** Full cascade incl. stage-0 (compounds/umbrella/version/token) — may yield many. */
  const predict = (mention: string): string[] =>
    normalizer
      .normalizeMention(mention)
      .map((n) => n.canonical_name)
      .filter((c): c is string => c !== null);

  // Global target-state metrics (vs FINAL expected labels — shows progress toward the bars).
  let tp = 0;
  let fp = 0;
  let fn = 0;
  // Ready-now subset (requires=[]) — label sanity: must ALL pass today.
  let readyTotal = 0;
  let readyCorrect = 0;
  let flippedRows = 0;
  const labelErrors: string[] = [];
  const overLabeled: string[] = []; // locked rows that already pass → 'requires' label is wrong
  const negativeFPs: string[] = [];
  const lockCounts: Record<RequiresTag, number> = { alias: 0, new_skill: 0, prenormalize: 0 };
  const byLang = new Map<string, { total: number; correct: number }>();
  const byCat = new Map<string, { total: number; correct: number }>();

  for (const row of mentions) {
    const predicted = predict(row.mention);
    const correct = setEq(predicted, row.expected);

    for (const p of predicted) {
      if (row.expected.includes(p)) tp += 1;
      else fp += 1;
    }
    for (const e of row.expected) if (!predicted.includes(e)) fn += 1;

    const lang = byLang.get(row.lang) ?? { total: 0, correct: 0 };
    lang.total += 1;
    if (correct) lang.correct += 1;
    byLang.set(row.lang, lang);

    const cat = byCat.get(row.category) ?? { total: 0, correct: 0 };
    cat.total += 1;
    if (correct) cat.correct += 1;
    byCat.set(row.category, cat);

    if (row.requires.length === 0) {
      readyTotal += 1;
      if (correct) readyCorrect += 1;
      else
        labelErrors.push(
          `  "${row.mention}" → got [${predicted.join(',')}], expected [${row.expected.join(',')}] (${row.category})`,
        );
    } else {
      for (const r of row.requires) lockCounts[r] += 1;
      if (correct) {
        overLabeled.push(
          `  "${row.mention}" already resolves but is marked requires=[${row.requires.join(',')}]`,
        );
        // FLIP mode: a step's implementation just unlocked this row — record it as ready.
        if (process.env.EVAL_MENTIONS_FLIP === '1') {
          row.requires = [];
          row.note = (row.note ?? '') + ' [unlocked — flipped by EVAL_MENTIONS_FLIP run]';
          flippedRows += 1;
        }
      }
    }

    // Sanity only for rows claiming to be clean TODAY; locked negatives (requires=['prenormalize'])
    // are KNOWN current false-positives that step-4's fuzzy guard must kill — they already count
    // against the global precision metric above.
    if (row.category === 'negative' && row.requires.length === 0 && predicted.length > 0) {
      negativeFPs.push(`  "${row.mention}" → [${predicted.join(',')}] (must match NOTHING)`);
    }
  }

  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const round3 = (x: number): number => Math.round(x * 1000) / 1000;

  console.log(`\nMention-normalization eval — ${mentions.length} rows (offline, 0 LLM calls)\n`);

  console.log('=== Label sanity (requires=[] must pass TODAY) ===');
  console.log(`ready-now: ${readyCorrect}/${readyTotal} (${pct(readyCorrect, readyTotal)})`);
  if (labelErrors.length) console.log(`LABEL ERRORS (ready row fails):\n${labelErrors.join('\n')}`);
  if (overLabeled.length)
    console.log(`OVER-LABELED (locked row passes):\n${overLabeled.join('\n')}`);
  if (negativeFPs.length) console.log(`NEGATIVE FALSE-POSITIVES:\n${negativeFPs.join('\n')}`);

  console.log('\n=== Progress toward TARGET labels (post step 2-4) ===');
  console.log(
    `precision ${round3(precision)} (bar ${PRECISION_BAR}) · recall ${round3(recall)} · F1 ${round3(f1)} (bar ${F1_BAR})`,
  );
  console.log(
    `locked rows → unlock plan: +alias ${lockCounts.alias} (step 2/3) · +new_skill ${lockCounts.new_skill} (step 3) · +prenormalize ${lockCounts.prenormalize} (step 4)`,
  );

  console.log('\n=== Per-language (vs target) ===');
  for (const [lang, s] of byLang)
    console.log(`${lang.padEnd(6)} ${s.correct}/${s.total} (${pct(s.correct, s.total)})`);

  console.log('\n=== Per-category (vs target) ===');
  for (const [cat, s] of [...byCat.entries()].sort())
    console.log(`${cat.padEnd(10)} ${s.correct}/${s.total} (${pct(s.correct, s.total)})`);

  if (flippedRows > 0) {
    fs.writeFileSync(
      file,
      JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf-8')), mentions }, null, 2) + '\n',
      'utf-8',
    );
    console.log(
      `\nFLIP mode: ${flippedRows} unlocked row(s) written back as requires=[] — re-run to verify clean.`,
    );
  }

  const sanityFail =
    labelErrors.length > 0 ||
    (overLabeled.length > 0 && flippedRows === 0) ||
    negativeFPs.length > 0;
  const strictFail = STRICT && (precision < PRECISION_BAR || f1 < F1_BAR);
  console.log(
    `\nVerdict: ${sanityFail ? 'FAIL ❌ (label/precision sanity)' : strictFail ? 'FAIL ❌ (strict bars not met yet)' : 'PASS ✅'}${STRICT ? ' [strict]' : ''}\n`,
  );
  process.exit(sanityFail || strictFail ? 1 : 0);
}

main().catch((err) => {
  console.error('\neval-mentions failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});

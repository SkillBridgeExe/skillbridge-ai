/**
 * R2 eval harness #3 — SEMANTIC fallback tier (embedding 3-band gate). Protocol lives in
 * data/eval-semantic.json (§protocol) — this file implements it verbatim.
 *
 *   pnpm eval:semantic                       # precondition gate + sweep (needs key)
 *   EVAL_SEMANTIC_STRICT=1 pnpm eval:semantic    # ALSO exit 1 if the pass bars fail
 *
 * TWO PARTS:
 *   1. PRECONDITION GATE (always, offline, no key/DB): every row must return [] from the
 *      deterministic cascade — a row it already resolves is a LABELING ERROR (exit 1).
 *   2. THRESHOLD SWEEP (only with OPENAI_API_KEY; NODE_ENV=test skips): build the skill
 *      matrix EXACTLY like production backfill (shared enumerateSkillVariants + embedBatch),
 *      embed the 52 mentions, sweep accept t ∈ [0.60, 0.90] step 0.01, pick the SMALLEST t
 *      with precision ≥0.90 overall AND per-language, then max recall (tie → lower t).
 *
 * PASS BARS (strict): precondition green · overall precision ≥0.90 · recall ≥0.60 ·
 * per-language precision ≥0.90 (en + vi) · ZERO semantic_negative auto-accepted at chosen t.
 * If no t qualifies → recommendation is needs_review-only mode (no auto-accept).
 *
 * Embeddings are cached to data/.cache/eval-semantic-vectors.json (keyed by tuple+text),
 * so re-runs are free — mirroring the production skill_resolutions cache.
 */
import * as dotenv from 'dotenv';
// SURGICAL override: a stale OS-level OPENAI_API_KEY has shadowed .env before (Windows gotcha);
// only that var is forced from .env — NODE_ENV etc. keep shell/CI precedence (offline contract).
const dotenvParsed = dotenv.config().parsed ?? {};
if (dotenvParsed.OPENAI_API_KEY) process.env.OPENAI_API_KEY = dotenvParsed.OPENAI_API_KEY;

import * as fs from 'fs';
import * as path from 'path';
import OpenAI from 'openai';
import { SkillTaxonomyService } from '../common/services/skill-taxonomy.service';
import { SkillNormalizerService } from '../common/services/skill-normalizer.service';
import { cosineSim, embedBatch, enumerateSkillVariants } from '../tools/embedding-shared';

interface SemanticRow {
  mention: string;
  lang: 'en' | 'vi';
  expected: string[];
  kind: 'semantic_hit' | 'semantic_negative';
  note?: string;
}

interface ScoredRow extends SemanticRow {
  top1Canonical: string;
  top1Text: string;
  top1Sim: number;
}

interface SweepPoint {
  t: number;
  tp: number;
  fp: number;
  fn: number;
  negAccepted: number;
  precision: number;
  recall: number;
  f1: number;
}

const STRICT = process.env.EVAL_SEMANTIC_STRICT === '1';
const PRECISION_BAR = 0.9;
const RECALL_BAR = 0.6;

const CACHE_DIR = path.join(process.cwd(), 'data', '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'eval-semantic-vectors.json');

/** precision with an empty denominator is vacuously 1 (nothing accepted → nothing wrong). */
const safeDiv = (n: number, d: number, empty = 1): number => (d === 0 ? empty : n / d);

function sweepPoint(rows: ScoredRow[], t: number): SweepPoint {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let negAccepted = 0;
  for (const r of rows) {
    const accepted = r.top1Sim >= t;
    if (r.kind === 'semantic_hit') {
      if (accepted && r.expected.includes(r.top1Canonical)) tp++;
      else if (accepted) {
        fp++; // accepted to the WRONG canonical…
        fn++; // …which is also a miss of the right one (protocol)
      } else fn++;
    } else if (accepted) {
      fp++;
      negAccepted++;
    }
  }
  const precision = safeDiv(tp, tp + fp);
  const recall = safeDiv(tp, tp + fn, 0);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { t, tp, fp, fn, negAccepted, precision, recall, f1 };
}

async function main(): Promise<void> {
  const file = path.join(process.cwd(), 'data', 'eval-semantic.json');
  const { rows } = JSON.parse(fs.readFileSync(file, 'utf-8')) as { rows: SemanticRow[] };

  // ── Part 1: precondition gate (label sanity — offline, always) ─────────────────────
  const taxonomy = new SkillTaxonomyService();
  await taxonomy.onModuleInit();
  const normalizer = new SkillNormalizerService(taxonomy);

  const labelErrors: string[] = [];
  for (const row of rows) {
    const resolved = normalizer
      .normalizeMention(row.mention)
      .map((n) => n.canonical_name)
      .filter((c): c is string => c !== null);
    if (resolved.length > 0) {
      labelErrors.push(
        `"${row.mention}" already resolves deterministically → [${resolved.join(', ')}]`,
      );
    }
  }
  console.log(
    `Precondition gate: ${rows.length - labelErrors.length}/${rows.length} rows stay unresolved`,
  );
  if (labelErrors.length > 0) {
    console.error('LABELING ERRORS (row belongs in eval-mentions, not here):');
    for (const e of labelErrors) console.error(`  ✗ ${e}`);
    process.exit(1);
  }

  // ── Part 2: threshold sweep (needs key; offline contract → skip cleanly) ───────────
  const apiKey = process.env.OPENAI_API_KEY;
  if (process.env.NODE_ENV === 'test' || !apiKey) {
    console.log('SKIPPED (no embeddings) — precondition gate passed; set OPENAI_API_KEY to sweep.');
    return;
  }

  const model = process.env.OPENAI_MODEL_EMBEDDING ?? 'text-embedding-3-large';
  const dimensions = parseInt(process.env.VECTOR_DIMENSION ?? '1024', 10);
  const embeddingVersion = process.env.VECTOR_EMBEDDING_VERSION ?? 'v1';
  const tupleKey = `${model}/${dimensions}/${embeddingVersion}`;

  const variants = enumerateSkillVariants(taxonomy.getAll());
  console.log(`\nMatrix: ${variants.length} skill surface forms · tuple ${tupleKey}`);

  // Disk cache: tuple-scoped map text → vector (mentions and skill texts share one space).
  let cache: { tuple: string; vectors: Record<string, number[]> } = {
    tuple: tupleKey,
    vectors: {},
  };
  if (fs.existsSync(CACHE_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')) as typeof cache;
    if (loaded.tuple === tupleKey) cache = loaded;
  }

  const allTexts = [...variants.map((v) => v.text), ...rows.map((r) => r.mention)];
  const missingTexts = [...new Set(allTexts)].filter((t) => !cache.vectors[t]);
  if (missingTexts.length > 0) {
    console.log(
      `Embedding ${missingTexts.length} uncached texts (cached: ${Object.keys(cache.vectors).length})…`,
    );
    const client = new OpenAI({ apiKey, maxRetries: 5, timeout: 60_000 });
    const { vectors, totalTokens } = await embedBatch(client, missingTexts, model, dimensions);
    missingTexts.forEach((t, i) => (cache.vectors[t] = vectors[i]));
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
    console.log(
      `Embedded · ${totalTokens} tokens · est $${((totalTokens / 1e6) * 0.13).toFixed(4)}`,
    );
  } else {
    console.log('All vectors served from cache (re-run cost: $0).');
  }

  // Score each mention: top-1 over the whole matrix (same as production nearestSkill LIMIT 1).
  const scored: ScoredRow[] = rows.map((row) => {
    const mv = cache.vectors[row.mention];
    let best = -Infinity;
    let bestVariant = variants[0];
    for (const v of variants) {
      const s = cosineSim(mv, cache.vectors[v.text]);
      if (s > best) {
        best = s;
        bestVariant = v;
      }
    }
    return {
      ...row,
      top1Canonical: bestVariant.canonical,
      top1Text: bestVariant.text,
      top1Sim: best,
    };
  });

  // Sweep 0.60 → 0.90 step 0.01 (avoid float drift via integer loop).
  const thresholds: number[] = [];
  for (let i = 60; i <= 90; i++) thresholds.push(i / 100);
  const en = scored.filter((r) => r.lang === 'en');
  const vi = scored.filter((r) => r.lang === 'vi');
  const curve = thresholds.map((t) => ({
    overall: sweepPoint(scored, t),
    en: sweepPoint(en, t),
    vi: sweepPoint(vi, t),
  }));

  console.log('\nPR curve (reporting focus 0.70–0.85):');
  console.log('   t    P_all  R_all  F1_all   P_en  R_en   P_vi  R_vi  negAcc');
  for (const c of curve) {
    if (c.overall.t < 0.7 || c.overall.t > 0.85) continue;
    const f = (x: number): string => x.toFixed(2).padStart(5);
    console.log(
      `  ${c.overall.t.toFixed(2)}  ${f(c.overall.precision)}  ${f(c.overall.recall)}  ${f(c.overall.f1)}   ` +
        `${f(c.en.precision)} ${f(c.en.recall)}  ${f(c.vi.precision)} ${f(c.vi.recall)}   ${c.overall.negAccepted}`,
    );
  }

  // Pick: smallest t with P≥0.90 overall AND per-language; among those max recall; tie → lower t.
  const qualifying = curve.filter(
    (c) =>
      c.overall.precision >= PRECISION_BAR &&
      c.en.precision >= PRECISION_BAR &&
      c.vi.precision >= PRECISION_BAR,
  );
  if (qualifying.length === 0) {
    console.log(
      `\nNO threshold in [0.60, 0.90] reaches precision ≥${PRECISION_BAR} overall + per-language.` +
        '\n→ DO NOT ship auto-accept: run the tier in needs_review-only mode and revisit after taxonomy expansion.',
    );
    process.exit(STRICT ? 1 : 0);
  }
  let chosen = qualifying[0];
  for (const c of qualifying) {
    if (
      c.overall.recall > chosen.overall.recall ||
      (c.overall.recall === chosen.overall.recall && c.overall.t < chosen.overall.t)
    ) {
      chosen = c;
    }
  }

  const accept = chosen.overall.t;
  const reviewLow = accept - 0.08;
  console.log(`\nCHOSEN accept threshold: ${accept.toFixed(2)}`);
  console.log(
    `  needs_review band: [${reviewLow.toFixed(2)}, ${accept.toFixed(2)}) · none below ${reviewLow.toFixed(2)}`,
  );
  console.log(`  → set SEMANTIC_ACCEPT_THRESHOLD=${accept.toFixed(2)} (SEMANTIC_REVIEW_BAND=0.08)`);

  // Pass bars at the chosen t.
  const bars: Array<[string, boolean, string]> = [
    ['precondition gate', true, 'all rows stay deterministically unresolved'],
    [
      `overall precision ≥ ${PRECISION_BAR}`,
      chosen.overall.precision >= PRECISION_BAR,
      chosen.overall.precision.toFixed(3),
    ],
    [
      `overall recall ≥ ${RECALL_BAR}`,
      chosen.overall.recall >= RECALL_BAR,
      chosen.overall.recall.toFixed(3),
    ],
    [
      `en precision ≥ ${PRECISION_BAR}`,
      chosen.en.precision >= PRECISION_BAR,
      chosen.en.precision.toFixed(3),
    ],
    [
      `vi precision ≥ ${PRECISION_BAR}`,
      chosen.vi.precision >= PRECISION_BAR,
      chosen.vi.precision.toFixed(3),
    ],
    [
      'zero negatives auto-accepted',
      chosen.overall.negAccepted === 0,
      String(chosen.overall.negAccepted),
    ],
  ];
  console.log('\nPASS BARS @ chosen t:');
  let allPass = true;
  for (const [name, ok, detail] of bars) {
    if (!ok) allPass = false;
    console.log(`  ${ok ? '✓' : '✗'} ${name} (${detail})`);
  }

  // Worst offenders for debugging — negatives closest to acceptance + hits furthest from it.
  const negsBySim = scored
    .filter((r) => r.kind === 'semantic_negative')
    .sort((a, b) => b.top1Sim - a.top1Sim)
    .slice(0, 5);
  console.log('\nClosest negatives (must stay below accept):');
  for (const n of negsBySim) {
    console.log(`  ${n.top1Sim.toFixed(4)}  "${n.mention}" → ${n.top1Canonical} ("${n.top1Text}")`);
  }
  const missedHits = scored
    .filter(
      (r) =>
        r.kind === 'semantic_hit' && (r.top1Sim < accept || !r.expected.includes(r.top1Canonical)),
    )
    .sort((a, b) => b.top1Sim - a.top1Sim);
  console.log(`\nHits NOT auto-accepted at ${accept.toFixed(2)} (${missedHits.length}):`);
  for (const m of missedHits) {
    const why = m.expected.includes(m.top1Canonical)
      ? 'below accept'
      : `WRONG TARGET (${m.top1Canonical})`;
    console.log(`  ${m.top1Sim.toFixed(4)}  "${m.mention}" — ${why}`);
  }

  if (STRICT && !allPass) process.exit(1);
}

main().catch((err) => {
  console.error(`eval-semantic failed: ${(err as Error).message}`);
  process.exit(1);
});

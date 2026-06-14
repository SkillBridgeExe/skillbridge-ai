# Pilot taxonomy data

These JSON files are the **pilot snapshot** of skill taxonomy + role rubrics, loaded into memory at NestJS startup by `SkillTaxonomyService` and `RoleRubricService`.

## Source of truth

These files are **copies** of the canonical seed data in the FE repo:

- `skills-pilot.json` ← copy of `skillbridge-fe-official/docs/database/seed/skills-pilot.json`
- `role-rubrics-pilot.json` ← copy of `skillbridge-fe-official/docs/database/seed/role-rubrics.json`

When the canonical files change, this directory MUST be re-synced (manually for pilot; in production, seed straight from these snapshots via a TypeORM migration/seeder).

## Production roadmap

After the 2026-05-30 NestJS pivot, **NestJS owns the canonical Postgres data via TypeORM** (no .NET fetch). In production:

```
JSON snapshot (here) → TypeORM seeder/migration → skills / role_skill_requirements tables
SkillTaxonomyService / RoleRubricService → load from DB (+ in-memory cache)
```

For pilot, we ship the JSON snapshot in-repo so NestJS is self-contained and can be tested without a live DB.

## Why local files for pilot?

- **Self-contained tests** — `npm run test:e2e` doesn't need a live DB.
- **Deterministic** — same JSON on disk = same taxonomy = same results.
- **Quick iteration** — change a skill weight in JSON, restart, see effect.
- **Demo-able offline** — works in airplane/coffee shop without a live DB.

---

# `eval:extractors` corpus contract (`data/eval-cvs-pdf/`)

The PDF-extractor A/B harness (`pnpm eval:extractors`, `src/calibration/eval-extractors.ts`)
compares `pdf-parse` (the current platform extractor) vs `unpdf` vs a `liteparse` reading-order
slot, on **real CV PDFs**.

> ⚠️ **THIN CORPUS — NOT production accuracy.** The whole `data/eval-cvs-pdf/` directory is
> **gitignored** (real CVs are personal data — never committed). The committed honesty lives in the
> harness code: it ALWAYS prints + embeds a disclaimer naming exactly which layout×lang combinations
> are present and which are missing. As of this writing the local corpus is only a couple of
> Vietnamese backend CVs (one of which is effectively a **scanned/image PDF** — `pdf-parse` pulls
> ~32 chars from it, a perfect real example of the failure `extraction_quality` flags). Do **not**
> cite these numbers as "overall extractor accuracy".

## Adding CVs (no code change needed)

1. Drop the `*.pdf` into `data/eval-cvs-pdf/` (stays gitignored — never commit real CVs).
2. (Optional) add an entry to the **per-machine** `data/eval-cvs-pdf/manifest.json` so the report is
   labelled. Without it the file is reported as `unknown/unknown/unknown` — still measured, just
   un-annotated.
3. `pnpm eval:extractors`.

### `manifest.json` schema (per-machine, gitignored)

```json
{
  "corpus_note": "free text",
  "files": [
    { "filename": "exact file name.pdf", "layout": "single_column", "lang": "vi", "source": "real" }
  ]
}
```

- `layout`: `single_column | two_column | canva | scanned | unknown`
- `lang`: `vi | en | mixed | unknown`
- `source`: `real | synthetic | redacted | unknown`

**Coverage we still need** to trust these numbers: `two_column`, `canva`, `scanned`, and **English**
CVs. The harness's disclaimer lists the exact missing `layout/lang` pairs each run.

## Related: `eval:cv-parse`

`pnpm eval:cv-parse` (`src/calibration/eval-cv-parse.ts`) measures the **text → CanonicalCvDocument**
LLM step (section recall + language detection) on **synthetic, text-only** fixtures
(`data/eval-cv-parse-cases.json` — committed, no PII). Report-only by default;
`EVAL_CV_PARSE_STRICT=1` gates it. The deterministic coercion safety-net is CI-gated separately by
`test/modules/cv-review/cv-parser.coerce.spec.ts`. Neither runs in CI's `pnpm test` LLM-free suite
except the coerce spec.

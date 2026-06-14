# SkillBridge AI Backend - Agent Context

Read this before making code, architecture, database, deployment, or AI-logic changes in this repo.

## Repository Identity

`skillbridge-ai` is the current **NestJS backend modular monolith** for SkillBridge.

It contains both:

- Public platform APIs under `/api/*`.
- Internal AI orchestration modules for CV diagnosis, CV/JD matching, gap analysis, rewrite, roadmap, interview, embeddings, RAG, tracing, and future MCP/tool calls.

Current high-level flow:

```txt
React FE (skillbridge-fe-official)
  -> NestJS backend (this repo, /api/*)
      -> PostgreSQL / Supabase + TypeORM
      -> LLM providers through LlmService
      -> Storage / jobs / tracing as needed
```

Do not assume there is a separate active `.NET` backend unless the user explicitly provides new current evidence. Older docs may mention `.NET`; treat those as stale for this repo unless confirmed.

## Product Focus

SkillBridge is an AI career platform. The strongest active product area is the **Diagnosis tab**:

- CV upload, parsing, scoring, ATS checks, bullet feedback.
- CV/JD matching and gap analysis.
- Evidence ledger: demonstrated vs mentioned vs listed-only skills.
- Gap Engine: normalized `gap_items`, severity, fixability, confidence.
- Tailor-to-JD actions and CV Patch Engine.
- Job market trends from crawled IT jobs.
- Later consumers: learning roadmap and interview practice.

The core product principle is:

```txt
Raw CV/JD data -> clean signals -> deterministic scoring/gaps/actions -> LLM only extracts or rewrites text
```

LLM must not be the primary scorer.

## Architecture Map

Main folders:

- `src/platform/**`: public API wrappers and user-owned workflows.
  - Auth, users, CVs, CV matches, interviews, billing, quota, verified tailor rewrite.
- `src/modules/**`: AI/product logic.
  - `cv-review`, `cv-jd-match`, `cv-builder`, `gap-engine`, `gap-report`, `jobs`, `roadmap`, `interview`, `github-evidence`, `embeddings`, `rag`, `tracing`, `prompts`.
- `src/common/**`: shared deterministic helpers, guards, evidence ledger, taxonomy, seniority, text quality.
- `src/infrastructure/**`: providers such as LLM, storage, vector access.
- `src/database/**`: TypeORM entities, migrations, seed.
- `prompts/**`: versioned prompt templates.
- `data/**`: rubrics, taxonomy, eval fixtures, course catalog, jobs snapshots.
- `docs/**`: architecture, status, handoff, scoring, research, and implementation notes.

Shared files such as `src/main.ts`, `src/app.module.ts`, `src/database/**`, and config files affect many flows. Edit them only when the task clearly requires it.

## Lane Ownership

AI/Product lane:

- `src/modules/cv-review/**`
- `src/modules/cv-jd-match/**`
- `src/modules/cv-builder/**`
- `src/modules/gap-engine/**`
- `src/modules/gap-report/**`
- `src/modules/interview/**`
- `src/modules/roadmap/**`
- `src/modules/jobs/**`
- `src/modules/github-evidence/**`
- `src/common/services/**` when it affects AI signals
- `prompts/**`
- `data/eval-*`, rubrics, taxonomy, skill graph, course catalog

Platform lane:

- `src/platform/auth/**`
- `src/platform/users/**`
- `src/platform/cvs/**`
- `src/platform/cv-matches/**`
- `src/platform/tailor-verifier/**`
- `src/platform/interviews/**`
- `src/platform/billing/**`
- quota, ownership, JWT, Cloud Run/runtime settings, destructive/account flows

Coordinate before changing shared platform/security/billing/destructive behavior. Do not revert unrelated worktree changes. Avoid `git add -A`; stage intentional files only.

## Diagnosis And Gap Rules

For CV diagnosis and CV/JD matching:

- Prefer deterministic code for scoring, severity, fixability, coverage, evidence risk, and final action eligibility.
- LLM may extract structured data or rewrite text, but code must validate and coerce it.
- Never let LLM decide final score, `gap_items.severity`, `fixability`, quota, ownership, or whether a user may rewrite a claim.
- Every gap/action should be traceable to CV/JD evidence, role rubric, or market data.
- Missing skills must not become rewrite suggestions. Tell the user to learn or add real evidence only if true.
- Listed-only skills should become `add_evidence` or `overclaimed` signals when appropriate.
- Demonstrated partial skills may become `deepen_wording` rewrite candidates.
- Market-implied gaps must be labeled as market/trend signals, not explicit JD requirements.

## PR4 / PR4.5 Tailor Rewrite Guardrails

The CV Patch Engine decorates `recommended_actions` with deterministic patch-plan fields:

- `action_id`
- `requirement_id`
- `fixability`
- `cv_section`
- `anchor_confidence`
- `before`
- `target_section`
- `insertion_hint`

Rules:

- `before` may appear only when a real CV bullet is found with high confidence.
- `emphasize` is not a single-bullet rewrite by default; it should use `insertion_hint` or user-selected real text.
- `missing_required` and `add_evidence` must not be accepted as tailor rewrite actions.
- Tailor rewrite must be server-verified. Do not trust FE-provided `tailor_action` facts.
- For `mode='tailor'`, the server should verify user ownership, load the match/review/gap report, find the real action by `match_id` + `action_id` or equivalent, check `rewrite_eligible`, and build the instruction from verified server data.
- Keep the number-invention guard. Add anti-fabrication guards conservatively and deterministically.

## Input Quality Rules

Diagnosis quality depends on the input signal chain:

```txt
file -> extracted text -> CanonicalCvDocument -> skill signals -> evidence ledger -> gap/score/action
```

Be careful with:

- PDF/DOCX/image extraction.
- OCR-only or scanned PDFs.
- Two-column/Canva/icon-heavy CVs.
- CV parser section mistakes.
- Skill taxonomy aliases and unnormalized skills.
- Proficiency and required-level inflation.
- Role rubric calibration by role/band.
- Evidence ledger strength: demonstrated vs mentioned vs listed-only.
- Market data quality: `role_code`, snapshots, co-occurrence, confidence.

When hardening these layers, add evals or golden cases when possible.

## Data, Prompts, And Tracing

- Use `PromptsService` and files in `prompts/**`. Do not hard-code long prompts in services.
- Use `LlmService` from `src/infrastructure/llm`. Do not import OpenAI/Gemini clients directly inside feature modules.
- Persist/trace AI requests through existing tracing services.
- Do not log raw CV text, JD text, emails, phone numbers, or other personal data.
- Redact PII in raw/parsed traces when storing evidence text.
- Keep prompt output schemas narrow and validate/coerce all model output before downstream use.

## Database And API Rules

- TypeORM entities/migrations are the DB source of truth for this repo.
- Do not use `synchronize: true` for production-like environments.
- Add indexes/constraints for new persistent relationships.
- Public API should stay under `/api/*`.
- Internal AI endpoints, if used, should stay guarded and not become a second public surface accidentally.
- Enforce ownership and quota in platform services, not in FE.

## Verification

Use `pnpm`.

Common commands:

```powershell
pnpm.cmd --dir .\skillbridge-ai build
pnpm.cmd --dir .\skillbridge-ai exec jest --runInBand
pnpm.cmd --dir .\skillbridge-ai exec eslint "{src,test}/**/*.ts"
pnpm.cmd --dir .\skillbridge-ai eval:match
pnpm.cmd --dir .\skillbridge-ai eval:gap
pnpm.cmd --dir .\skillbridge-ai eval:patch
pnpm.cmd --dir .\skillbridge-ai eval:jd-extract
pnpm.cmd --dir .\skillbridge-ai eval:extractors
```

Run the narrowest relevant checks while iterating, then broader checks before claiming completion.

Known lint state may include warnings in tests; report them honestly.

## Current Strategic Roadmap

Gap Engine v2 sequence (shipped to `main`):

- PR1 (`feat/gap-engine-foundation`, #62): canonical `GapItem` + `buildGapItems()` + `eval:gap`.
- PR2 (`feat/gap-severity-formula`, #63): severity formula — market_demand, evidence_risk, interview_risk.
- PR3 (`feat/jd-intelligence-v2`, #64/#65): seniority grading, JD-intelligence extraction scaffold, prompt v2 dormant.
- PR4 (`feat/cv-patch-engine`, #66): CV Patch Engine — deterministic patch plan wired into `recommended_actions`.
- PR4.5 (`feat/verified-tailor-rewrite`, #67 ✅ MERGED): `TailorVerifierService` — FE sends only `match_id + action_id`; server reloads match + gap-report, verifies ownership + eligibility, builds LLM instruction from server-verified action only. Closes the FE trust boundary on tailor rewrite.

Next priorities (input hardening — NOT new features):

1. ~~Server-verified tailor rewrite~~ → **DONE** (PR #67).
2. ~~FE Patch UI consumes patch fields~~ → **DONE** (FE PR #51).
3. Flip `cv_jd_match_v2` only when FE and BE are ready (W19 brief exists, prompt already in BE).
4. Input/extractor quality hardening: `cv_parse_v1` evals, multi-extractor/OCR fallback for scanned CVs. Requires real-CV corpus from user.
5. Proficiency/required-level anti-inflation eval (craftable golden cases, no corpus needed).
6. Role rubric calibration per role/band (needs GOLDEN CVs per role).
7. Market hardening: role-code backfill for 308/799 jobs missing `role_code`, co-occurrence snapshots, data confidence.
8. CV Profile Signals parser for language, education, domain, work mode (PR3b).
9. PR6: Roadmap + Interview consume shared `GapReport` / `gap_items`.

Keep the system boring, traceable, and hard to fool. That is the moat.

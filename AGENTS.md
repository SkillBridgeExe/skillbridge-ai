# SkillBridge Backend (NestJS) — Agent Context

> Read this before making changes. Shared context for Codex, Claude, Antigravity, and other AI agents.
> ⚡ **2026-05-30 PIVOT:** this repo is now the **SINGLE backend** (NestJS-only). Full design in `ARCHITECTURE.md`.

## Service identity

`skillbridge-ai` is now the **single NestJS backend** for SkillBridge — a **modular monolith** ("Opt 2"):

- **Platform (public BFF):** auth, users/profiles, cvs, job-descriptions, billing/quota, history. Owns PostgreSQL + TypeORM migrations.
- **AI module (internal bounded context):** LLM calls, RAG over pgvector, versioned prompts, response parsing/validation, MCP/tool-call traceability.

> ⛔ The old **.NET BFF is dropped**. This repo absorbs its responsibilities. Any old text saying "internal only / called by .NET / FE never calls this" is **obsolete**.

## Architecture position

```txt
React FE (skillbridge-fe-official)
   -> NestJS backend (THIS repo)   [Platform /api/*]  +  [internal AI module]
        -> PostgreSQL (+ pgvector) via TypeORM
        -> LLM: Gemini (@google/genai) / OpenAI
```

FE calls `/api/*`. The AI module is invoked intra-process by platform services (or via guarded `/internal/ai/*`). Gemini Live WS is the only FE→Google direct path (ephemeral token brokered here).

## Stack (verified 2026-05-30 — see ARCHITECTURE.md §5)

NestJS **11** · TypeORM **0.3** (Postgres + pgvector) · **`@google/genai`** (⚠️ replaces dead `@google/generative-ai`) · `openai` **v6** · Passport + `@nestjs/jwt` · `@nestjs/throttler` · class-validator · `@nestjs/config` · eslint **9**.

## Code split (2 devs) — see ARCHITECTURE.md §2

- **`src/platform/**` — Dev B (ex-.NET):** auth, users, cvs, job-descriptions, billing, public gateway, entities + migrations.
- **`src/ai/**` — Dev A (FE + AI):** cv-review, cv-jd-match, interview, roadmap, skills, embeddings, rag, prompts, tracing.
- **`src/shared`, `src/infrastructure`, `src/config`, `src/database`:** edit-sparingly, coordinate between devs.

## Hard rules

- **Public-facing now:** global `ValidationPipe` (`whitelist`), `@nestjs/throttler` rate-limit, `helmet`, strict CORS (FE origin only). `JwtAuthGuard` default; `@Public()` for login/register/health.
- **TypeORM is the DB authority:** `synchronize: false` outside personal dev; **migrations are the source of truth** (like EF Migrations). No raw SQL except vetted pgvector similarity queries.
- **Schema source of truth:** `../skillbridge-fe-official/docs/database/skillbridge-mvp.dbml` (38 tables). Don't invent tables/columns.
- **AI traceability (keep, first-class):** every LLM call → `ai_requests` via `TracingService`; every retrieval → `retrieval_logs`; every tool call → `ai_tool_calls`. Don't bypass.
- **LLM abstraction:** use `LlmService` from `infrastructure/llm`. Do NOT import `@google/genai` / `openai` directly in feature modules.
- **Prompts:** load via `PromptsService` from `prompts/<code>_v<n>.md`. Don't hard-code.
- **PII:** CV text is personal data → redact from logs/traces; soft + hard delete; consent on upload.
- **Heavy AI runs async** via `ai_jobs` (FE polls) — don't block request threads.

## Conventions

- TypeScript strict mode ON. DTOs use `class-validator`.
- Response envelope (`ResponseInterceptor` / `AllExceptionsFilter`): `{ success, message, data, errors, errorCode? }`. `errors` field-keyed for validation; `errorCode` for client branching.
- Correlation ID via `X-Correlation-Id` header + `@CorrelationId()` decorator.
- Layering + folder layout: **see `ARCHITECTURE.md`** (pragmatic clean architecture: controller → service → domain ← infrastructure via ports).

## Verify before "done"

```powershell
npm run lint
npm run test
npm run build
npm run typeorm migration:run   # once TypeORM is wired
```

## Migration status (R0)

Repo is being re-set-up to the enterprise blueprint (`ARCHITECTURE.md` §7). The committed `package.json` is still the **OLD** stack (NestJS 10, dead Google SDK, no TypeORM) → follow the §7 checklist. Build stays **RED** until R0 migration lands; do it step-by-step, build green before each next step.

## Related repos

- `../skillbridge-fe-official` — React FE (calls this backend) + canonical docs (DBML, `api-contract.md`, plans).
- `../skillbridge-be` (.NET) — **deprecated by the 2026-05-30 pivot; not used.**
- `../Exe-SkillBridge` — original full-stack prototype; UI/behavior reference only.

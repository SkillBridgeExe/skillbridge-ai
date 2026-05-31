# SkillBridge Backend (NestJS)

> The **single backend** for SkillBridge — public BFF **+** internal AI orchestration in one NestJS modular monolith.
> ⚡ **2026-05-30:** pivoted from .NET → **NestJS-only**. Architecture detail: `docs/ARCHITECTURE.md`. Agent rules: `AGENTS.md`.

## What this service does

- **Platform (public API `/api/*`):** auth, users/profiles, CVs (upload/CRUD), job-descriptions, billing/quota, history. Owns PostgreSQL + TypeORM migrations.
- **AI (internal module):** LLM calls (Gemini/OpenAI), RAG over pgvector, versioned prompts, response parsing/validation, MCP/tool-call traceability.

| Domain | Public endpoint | Purpose |
|--------|-----------------|---------|
| Auth | `POST /api/auth/{register,login,refresh,logout,google}` · `GET /api/auth/me` | JWT + Google, refresh cookie |
| CV | `POST /api/cvs` · `GET /api/cvs/:id` · `DELETE /api/cvs/:id` | upload + diagnosis |
| Diagnosis | `POST /api/diagnosis/{cv-review,cv-jd-match}` · `GET /api/diagnosis/history` | AI scoring |
| Interview | `POST /api/interview/{start,answer,end}` | mock interview |
| Roadmap | `POST /api/roadmaps/generate` | learning roadmap |
| Health | `GET /health` | liveness (no auth) |

Internal AI lives under `/internal/ai/*` (or direct service calls), invoked **intra-process** by platform services — not exposed to FE.

## Architecture

```txt
React FE  ->  NestJS backend (THIS repo)  ->  PostgreSQL (+ pgvector) via TypeORM
               [platform /api/*]  +  [internal AI module]  ->  Gemini (@google/genai) / OpenAI
```
FE calls `/api/*` only. The one FE→Google direct path is the Gemini Live WS (ephemeral token brokered here). Full design + 2-dev code split: see `docs/ARCHITECTURE.md`.

## Tech stack (verified 2026-05-30)

Node 20+ · **NestJS 11** · TypeScript 5.6 strict · **TypeORM 0.3** (Postgres + pgvector) · **`@google/genai`** + **`openai` v6** · Passport + `@nestjs/jwt` · `@nestjs/throttler` + helmet · class-validator · Jest.

## Code ownership (2 devs)

| Area | Owner |
|------|-------|
| `src/platform/**` (auth, users, cvs, billing, gateway, entities, migrations) | **BE chính dev** |
| `src/modules/**` (→ `ai/`), `src/infrastructure/llm`, `src/common` (AI helpers) | **AI dev** |
| `src/database`, `src/config`, `app.module.ts`, `main.ts` | shared (platform dev leads) |

## Getting started

```powershell
npm install
Copy-Item .env.example .env
# Fill: DATABASE_URL (Postgres set up by the platform dev), GEMINI_API_KEY,
#       INTERNAL_AUTH_SECRET, JWT secrets (dev defaults exist).

npm run dev          # = nest start --watch  ->  http://localhost:3002
```
- `npm run start` = run once (no watch) · `npm run start:prod` = run built `dist/`.
- **Run without a DB** (smoke test): `$env:NODE_ENV="test"; node dist/main` → boots, skips DB/auth.
- Health: `GET http://localhost:3002/health`.

## Scripts

```powershell
npm run dev / start:dev          # watch (hot restart on save)
npm run build / start:prod
npm run lint / test / test:e2e
npm run migration:generate -- src/database/migrations/<Name>   # then: npm run migration:run
```

## Database

NestJS **owns** PostgreSQL via **TypeORM** (no more .NET split). Schema source of truth: `../skillbridge-fe-official/docs/database/skillbridge-mvp.dbml` (38 tables). `synchronize: false` outside personal dev — **migrations are authoritative** (like EF Migrations). Entities in `src/database/entities/`.

## Project structure

```txt
src/
├── main.ts · app.module.ts
├── config/                  # typed env + validation
├── database/                # TypeORM data-source, entities/, migrations/
├── shared|common/           # guards, interceptors, filters, decorators, dto
├── infrastructure/          # llm (Gemini/OpenAI), vector (pgvector), storage (R2)
├── platform/                # [BE dev] auth, users, cvs, job-descriptions, billing, gateway
└── modules/  (→ ai/)        # [AI dev] cv-review, cv-jd-match, interview, roadmap,
                             #          embeddings, rag, prompts, tracing
prompts/                     # versioned prompt templates (<code>_v<n>.md)
data/                        # pilot seed snapshots (skills, rubrics, course catalog)
```

## Related repos

- `../skillbridge-fe-official` — React FE (calls this backend) + canonical docs (DBML, api-contract, plans).
- `../skillbridge-be` (.NET) — **deprecated by the 2026-05-30 pivot; not used.**
- `../Exe-SkillBridge` — original full-stack prototype; UI/behavior reference only.

## License

Private. Internal use only.

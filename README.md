# SkillBridge AI Service

> Internal AI orchestrator for SkillBridge. NestJS service that handles LLM calls, RAG retrieval, prompt management, and MCP tool calling.
>
> **This service is NOT exposed to the public internet.** It is called only by the .NET BFF (`skillbridge-be`).

## What this service does

| Domain | Endpoints | Purpose |
|--------|-----------|---------|
| CV Review | `POST /internal/ai/cv-review` | AI quality review of a CV |
| CV/JD Match | `POST /internal/ai/cv-jd-match` | Composite scoring (semantic + LLM + rule engine) |
| Interview | `POST /internal/ai/interview/{start,answer,end}` | 4-phase mock interview with per-question + final scoring |
| Roadmap | `POST /internal/ai/roadmap/generate` | RAG-based learning roadmap generation |
| Embeddings | `POST /internal/ai/embeddings/index` | Index documents into pgvector |
| RAG | `POST /internal/ai/rag/query` | Retrieval helper (internal) |

Full contract: see `../skillbridge-fe-official/docs/api-contract.md`

## Architecture position

```txt
React FE  ->  .NET Main Backend / BFF  ->  THIS SERVICE  ->  LLM / pgvector / MCP
                                                |
                                           Postgres (write-only on ai_* tables)
```

## Tech stack

- **Runtime:** Node 20+
- **Framework:** NestJS 10 (modular monolith)
- **Language:** TypeScript 5.6 (strict mode)
- **LLM:** Google Gemini (primary) + OpenAI (fallback)
- **Vector store:** pgvector (in the main Postgres)
- **Validation:** class-validator + Joi
- **Tests:** Jest + Supertest

## Project structure

```txt
src/
├── main.ts                      # Bootstrap
├── app.module.ts                # Root module
│
├── config/                      # Typed config + Joi validation
│
├── common/                      # Shared building blocks
│   ├── guards/                  # InternalAuthGuard (X-Internal-Auth check)
│   ├── interceptors/            # CorrelationId, Response shape
│   ├── filters/                 # AllExceptionsFilter
│   ├── decorators/              # @CorrelationId(), @InternalUser()
│   ├── dto/                     # ApiResponseDto
│   └── constants/               # Error codes, header names
│
├── infrastructure/              # Cross-cutting infra
│   ├── database/                # Postgres client
│   ├── vector/                  # pgvector wrapper
│   └── llm/                     # LLM provider abstraction (Gemini/OpenAI)
│
└── modules/                     # Business features (one folder per feature)
    ├── health/                  # GET /health
    ├── prompts/                 # Prompt template loader + renderer
    ├── tracing/                 # Writes ai_requests, ai_results, retrieval_logs, ai_tool_calls
    ├── embeddings/              # POST /internal/ai/embeddings/index
    ├── rag/                     # POST /internal/ai/rag/query
    ├── cv-review/               # POST /internal/ai/cv-review
    ├── cv-jd-match/             # POST /internal/ai/cv-jd-match
    ├── interview/               # POST /internal/ai/interview/{start,answer,end}
    └── roadmap/                 # POST /internal/ai/roadmap/generate

prompts/                         # Prompt templates (markdown, version-controlled)
├── cv_review_v1.md
├── cv_jd_match_v1.md
├── interview_technical_v1.md
├── interview_screening_v1.md
├── interview_scoring_v1.md
└── roadmap_v1.md

test/                            # E2E tests
```

Every feature module follows the same shape:

```txt
modules/<feature>/
├── <feature>.module.ts          # @Module() registration
├── <feature>.controller.ts      # Route handlers
├── <feature>.service.ts         # Business logic
├── <feature>.parser.ts          # (optional) LLM JSON schema validation
└── dto/                         # Request + response DTOs with class-validator
```

## Getting started

### Prerequisites

- Node 20+
- npm 10+
- Docker (optional, for local Postgres + pgvector)

### Install + run

```powershell
npm install
cp .env.example .env
# Fill GEMINI_API_KEY (and OPENAI_API_KEY if using fallback)

npm run start:dev
```

The service starts on `http://localhost:3002`.

### Verify

```powershell
# Health check (no auth required)
curl http://localhost:3002/health

# Internal endpoint (requires X-Internal-Auth header)
curl -X POST http://localhost:3002/internal/ai/cv-review `
  -H "Content-Type: application/json" `
  -H "X-Internal-Auth: change-me-to-a-strong-random-string" `
  -H "X-Correlation-Id: 11111111-1111-1111-1111-111111111111" `
  -H "X-User-Id: 22222222-2222-2222-2222-222222222222" `
  -d '{ "cv_id": "uuid", "parsed_text": "...", "prompt_template_code": "cv_review_v1" }'
```

### Common scripts

```powershell
npm run start:dev      # Dev mode, hot reload
npm run build          # Production build -> dist/
npm run start:prod     # Run production build
npm run lint           # ESLint + Prettier auto-fix
npm run test           # Unit tests
npm run test:e2e       # End-to-end tests
```

## Database access

This service has **write access only** to the following tables (all in the same Postgres as .NET):

- `ai_jobs`
- `ai_requests`
- `ai_results`
- `documents`
- `document_chunks`
- `embedding_jobs`
- `retrieval_logs`
- `ai_tool_calls`

All other tables (`users`, `cvs`, `interview_sessions`, etc.) are **read-only** from this service. Business writes go through .NET.

## Internal auth

All endpoints under `/internal/ai/*` require these headers from .NET:

| Header | Purpose |
|--------|---------|
| `X-Internal-Auth` | Shared secret (env: `INTERNAL_AUTH_SECRET`) |
| `X-Correlation-Id` | UUID v4, propagated from FE -> .NET -> here for tracing |
| `X-User-Id` | UUID of the end user .NET is acting on behalf of |

Health check (`GET /health`) is the only unauthenticated route.

## Adding a new feature module

1. Generate skeleton: copy `modules/health/` as a starting point
2. Define DTOs in `<feature>/dto/` with `class-validator` decorators
3. Wire LLM in service via `LlmService` from `infrastructure/llm/`
4. Wire prompt template via `PromptsService` from `modules/prompts/`
5. Write tracing via `TracingService` from `modules/tracing/`
6. Register the module in `app.module.ts`
7. Add E2E test in `test/`
8. Update `prompts/` if a new prompt template is needed
9. Update `../skillbridge-fe-official/docs/api-contract.md` Part 2

## Related repos

- `skillbridge-fe-official` — React FE (calls .NET, never this service directly)
- `skillbridge-be` — .NET Main Backend / BFF (the only caller of this service)

## License

Private. Internal use only.

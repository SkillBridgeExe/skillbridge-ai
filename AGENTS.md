# SkillBridge AI Service — Agent Context

> Read this before making changes. This file is the shared context for Codex, Claude, Antigravity, and other AI agents.

## Service identity

This is the **NestJS AI Orchestrator** for SkillBridge. It handles:

- LLM calls (Gemini primary, OpenAI fallback)
- RAG retrieval over pgvector
- Prompt template management (versioned)
- Response parsing + schema validation
- MCP / tool-calling traceability

It is **internal only** — called by the .NET BFF, never directly by the React FE.

## Architecture position

```txt
React FE  ->  .NET BFF  ->  THIS SERVICE  ->  LLM / pgvector / MCP
                              |
                         writes ai_* + documents tables in Postgres
```

## Hard rules

- This service has **no public routes** (except `/health`). Every `/internal/ai/*` endpoint requires `X-Internal-Auth`.
- Do not expose this service to the public internet. Cloud Run service must be internal/VPC-only.
- The FE **never** calls this service directly. Live Voice (Gemini Live WS) is the only edge case, and even then the token is brokered by .NET.
- Database write access is limited to: `ai_jobs`, `ai_requests`, `ai_results`, `documents`, `document_chunks`, `embedding_jobs`, `retrieval_logs`, `ai_tool_calls`. All other tables are read-only.
- Business outputs (e.g. `cv_matches`, `interview_sessions.overall_score`) are written by .NET based on data returned by this service.
- Every LLM call must be logged in `ai_requests` (tokens, latency, cost, model).
- Every retrieval must be logged in `retrieval_logs`.
- Every tool call must be logged in `ai_tool_calls`.

## API contract

The single source of truth for the public/internal API contract is:

```txt
../skillbridge-fe-official/docs/api-contract.md
```

Part 2 of that file covers every `/internal/ai/*` endpoint owned by this service. Update both this code and that file when contracts change.

## Project conventions

- TypeScript strict mode is on. Do not turn it off.
- All DTOs use `class-validator` decorators.
- All responses use the shared envelope synced with .NET backend (`docs/api-response-standard.md` in `skillbridge-be`):
  - Success (via `ResponseInterceptor`): `{ success: true, message: null, data, errors: null }`
  - Error (via `AllExceptionsFilter`): `{ success: false, message, data: null, errors, errorCode }`
  - `errors` is a field-keyed object (e.g. `{ email: ["..."] }`) for validation; `null` otherwise.
  - `errorCode` is a NestJS-only field for client branching (proposed for .NET adoption — pending sync).
- All endpoints under `/internal/ai/*` use `InternalAuthGuard` (registered globally — do not remove).
- Correlation IDs flow via `X-Correlation-Id` header and are accessible via `@CorrelationId()` decorator.

## Module structure

```txt
src/
├── config/           # Typed env + Joi validation. ONE source of truth for env access.
├── common/           # Guards, interceptors, filters, decorators, DTOs, constants
├── infrastructure/   # database, vector, llm — cross-cutting infra
└── modules/          # Business features (each in its own folder, identical shape)
```

Every feature module follows this shape (no exceptions):

```txt
modules/<feature>/
├── <feature>.module.ts
├── <feature>.controller.ts     # Thin: route + DTO validation only
├── <feature>.service.ts        # Business logic
├── <feature>.parser.ts         # (optional) LLM output schema validation
└── dto/                        # Request + response DTOs
```

## Prompt management

- Prompts live in `prompts/` as markdown files
- Naming: `<code>_v<version>.md` (e.g. `cv_review_v1.md`)
- Loaded at startup by `PromptsService`
- Rendered with `{{placeholders}}` -> `template-renderer.ts`
- Bumping a version creates a new file; the DB `ai_prompt_templates` row tracks which is active

## LLM provider abstraction

Use `LlmService` from `infrastructure/llm/`. Do not import `@google/generative-ai` or `openai` directly in feature modules.

`LlmService.complete()` returns `{ rawResponse, parsedJson, tokenUsage, modelCode, latencyMs }` for every call. The service handles:

- Provider selection (Gemini vs OpenAI)
- Retry on transient errors
- JSON mode where supported
- Token + latency tracking
- Errors wrapped as `AI_ANALYSIS_FAILED` or `AI_SERVICE_UNAVAILABLE`

## Tracing — first-class

Every LLM call **must** create an `ai_requests` row. Every retrieval **must** create a `retrieval_logs` row. Use `TracingService`:

```ts
const requestId = await tracing.startAiRequest({ userId, jobId, modelId, ... });
// ... call LLM ...
await tracing.completeAiRequest(requestId, { tokens, latency, response });
```

Do not bypass this. The AI/RAG/MCP demo evidence depends on it.

## Verify before "done"

```powershell
npm run lint
npm run test
npm run build
```

## Things to avoid

- Do not write to `users`, `cvs`, `interview_sessions`, or other business tables. That is .NET's job.
- Do not call LLM providers directly from controllers. Always go through `LlmService`.
- Do not hard-code prompts. Always load from `PromptsService`.
- Do not add public routes. If you think you need one, talk to the user first.
- Do not skip `TracingService` calls. Every LLM call must leave a trail.

## Related repos

- `../skillbridge-fe-official` — React FE
- `../skillbridge-be` — .NET BFF (only caller of this service)

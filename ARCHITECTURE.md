# skillbridge-ai — Enterprise NestJS Architecture & Setup Blueprint

> **Trạng thái:** kế hoạch setup (2026-05-30). Đây là **blueprint** để dựng lại `skillbridge-ai` cho chuẩn enterprise sau pivot **NestJS-only**. Thực thi (apply package.json + migrate code + verify build) = **R0**, làm có kiểm soát, KHÔNG áp một phát rồi để build đỏ.
>
> Bối cảnh pivot: bỏ .NET → NestJS làm **cả public BFF lẫn AI orchestration** (1 backend, modular monolith). 2 dev cùng code NestJS → cần ranh giới module rõ để chia việc.

---

## 1. Nguyên tắc kiến trúc (pragmatic clean architecture)

Mục tiêu: **clean nhưng không over-engineer** cho team 2 người. Layering theo hướng phụ thuộc **vào trong**:

```
Presentation (controllers, DTO, guards)   ← HTTP, validation, auth
        ↓ depends on
Application (services / use-cases)         ← business logic, orchestrate
        ↓ depends on
Domain (entities, value types, rules)      ← thuần, KHÔNG import framework
        ↑ implemented by
Infrastructure (TypeORM repos, LLM, storage) ← adapter ra ngoài, inject qua interface (port)
```

**Luật:**
- Controller **mỏng**: chỉ route + validate DTO + gọi service. Không business logic.
- Service = use-case; phụ thuộc **interface/port**, không phụ thuộc class hạ tầng cụ thể.
- Entity (domain) **không** import NestJS/TypeORM-runtime logic ngoài decorator mapping.
- Hạ tầng "dễ đổi" (LLM provider, vector store, file storage) **bắt buộc** ẩn sau port (interface) — đã có `LlmService`, mở rộng pattern này.
- **KHÔNG** dùng CQRS/event-sourcing/full-hexagonal lúc này (thừa cho 2 người). Repository pattern + DI + port cho phần volatile là đủ.

---

## 2. Hai bounded context (để CHIA CODE 2 DEV)

Pivot bỏ .NET ⇒ phần việc .NET cũ (auth, CRUD, billing) giờ là NestJS. Chia repo thành **2 nhóm module** theo đúng thế mạnh, ít đụng nhau (khác thư mục → ít merge conflict):

| Nhóm | Thư mục | Ai làm | Gồm |
|---|---|---|---|
| **Platform** (BFF cũ của .NET) | `src/platform/**` | **Dev B** (ex-.NET) | auth, users/profiles, cvs (CRUD+upload), job-descriptions, billing (plans/subs/payments/quota), public gateway `/api/*`, TypeORM entities + migrations |
| **AI** (orchestration) | `src/ai/**` | **Dev A** (bạn — FE+AI) | cv-review, cv-jd-match, interview, roadmap, embeddings, rag, skills (taxonomy/normalizer/rubric/diff), prompts, tracing |
| **Shared/Infra** | `src/shared`, `src/infrastructure`, `src/config`, `src/database` | cùng sửa (đổi ít) | guards, interceptors, filters, llm providers, vector, storage, env, datasource |

> Platform gọi AI qua **interface nội bộ** (service injection hoặc `/internal/ai/*` controller có guard), KHÔNG để FE chạm AI trực tiếp.

---

## 3. Cấu trúc thư mục mục tiêu

```
src/
├── main.ts                      # bootstrap: ValidationPipe global, Throttler, helmet, CORS
├── app.module.ts                # ráp ConfigModule, TypeOrmModule, ThrottlerModule, Platform*, Ai*
├── config/                      # @nestjs/config + schema validate (Joi/Zod). 1 nguồn đọc env.
├── database/
│   ├── data-source.ts           # TypeORM DataSource (CLI migrations dùng file này)
│   ├── migrations/              # migration sinh từ entity (KHÔNG synchronize ở prod)
│   └── typeorm.config.ts        # forRootAsync factory
├── shared/                      # cross-cutting (đổi tên từ common/)
│   ├── guards/                  # JwtAuthGuard, RolesGuard, InternalGuard
│   ├── interceptors/            # ResponseInterceptor (envelope), LoggingInterceptor
│   ├── filters/                 # AllExceptionsFilter (envelope + errorCode)
│   ├── decorators/              # @CurrentUser, @Roles, @CorrelationId
│   ├── dto/                     # ApiResponse, Pagination
│   └── errors/                  # domain error types
├── infrastructure/
│   ├── llm/                     # LlmService + ports + providers (gemini @google/genai, openai)
│   ├── vector/                  # pgvector repository (similarity search)
│   └── storage/                 # Cloudflare R2 / S3 adapter (upload CV)
├── platform/                    # ── Dev B ──
│   ├── auth/                    # Passport(jwt+google) + @nestjs/jwt; register/login/refresh/logout/me
│   ├── users/                   # users, user_profiles, roles, user_roles
│   ├── cvs/                     # cvs CRUD + upload (gọi ai/cv-review)
│   ├── job-descriptions/
│   ├── billing/                 # plans, features, subscriptions, payments, quota
│   └── gateway/                 # (tùy) controller tổng hợp /api/* nếu muốn tách khỏi từng module
└── ai/                          # ── Dev A ──
    ├── cv-review/               # parse + score (R1)
    ├── cv-jd-match/
    ├── interview/
    ├── roadmap/
    ├── skills/                  # taxonomy, normalizer, rubric, diff (deterministic, đã có)
    ├── embeddings/  ├── rag/
    ├── prompts/     └── tracing/
```

Mỗi feature module: `*.module.ts` · `*.controller.ts` (mỏng) · `*.service.ts` (use-case) · `*.repository.ts` (TypeORM) · `entities/*.entity.ts` · `dto/`.

---

## 4. TypeORM (thay raw `pg` — giống Entity Framework cho dân .NET)

- **DataSource** ở `database/data-source.ts` (CLI migration đọc file này). App dùng `TypeOrmModule.forRootAsync` (đọc config).
- `synchronize: false` ở mọi môi trường ≠ dev cá nhân. **Migration là source of truth** (giống EF Migrations).
- Entity map đúng DBML 38 bảng (`docs/database/skillbridge-mvp.dbml` ở FE repo). Dùng `timestamptz`, `numeric(12,2)` tiền, `numeric(5,2)` score; index mọi FK; composite unique cho bảng N-N.
- **pgvector:** cột `document_chunks.embedding` kiểu `vector(768)`. TypeORM 0.3 hỗ trợ kiểu `vector`/`halfvec`; query similarity qua raw/`pgvector` npm helper.
- Mapping quen thuộc EF:
  - `DbContext` → `DataSource`; `DbSet<T>` → `Repository<T>`; `[Table]/[Column]` → `@Entity()/@Column()`; `Add-Migration` → `typeorm migration:generate`; `Update-Database` → `migration:run`.

---

## 5. Dependency matrix (ĐÃ VERIFY 2026-05-30 — thay bản cũ)

| Lĩnh vực | Package | Bản | Ghi chú vs hiện tại |
|---|---|---|---|
| Core | `@nestjs/{common,core,platform-express}` | **^11** | repo đang ^10.4 → bump |
| DB | `@nestjs/typeorm` | **^11** (11.0.1) | MỚI |
| | `typeorm` | **^0.3** | MỚI (thay raw pg query) |
| | `pg` | ^8 | giữ |
| | `pgvector` | latest | MỚI — helper similarity |
| Config | `@nestjs/config` | bản hợp NestJS 11 | giữ |
| Validate | `class-validator` ^0.14 · `class-transformer` ^0.5 | | giữ |
| | `zod` hoặc `joi` | | đang joi — ok |
| Auth (MỚI) | `@nestjs/jwt` · `@nestjs/passport` · `passport` · `passport-jwt` | | MỚI — phần .NET cũ |
| | `bcrypt` (hoặc `argon2`) · `google-auth-library` | | hash + verify google id_token |
| Rate-limit (MỚI) | `@nestjs/throttler` | | public-facing nên cần |
| **LLM** | **`@google/genai`** | latest | ⚠️ **THAY `@google/generative-ai` (EOL 31/08/2025)** |
| | `openai` | **^6** | repo đang ^4.67 → bump (v5→v6 breaking) |
| Misc | `reflect-metadata` ^0.2 · `rxjs` ^7 · `uuid` ^10 | | giữ |
| Dev | `@nestjs/{cli,schematics,testing}` ^11 · `typescript` ^5.6+ | | bump |
| | `eslint` **^9** (flat config) + `typescript-eslint` ^8 | | repo đang eslint 8 |
| | `jest` ^29 · `ts-jest` · `supertest` | | giữ |

### Provider Gemini — API mới `@google/genai`
```ts
import { GoogleGenAI } from '@google/genai';
const ai = new GoogleGenAI({ apiKey: cfg.geminiApiKey });
const res = await ai.models.generateContent({
  model: 'gemini-2.0-flash',
  contents: prompt,
  // JSON mode, temperature... qua config
});
```
(SDK cũ `new GoogleGenerativeAI(...).getGenerativeModel(...)` đã chết.)

---

## 6. Public-facing posture (NestJS giờ lộ ra ngoài)

Trước đây NestJS "internal-only sau .NET". Giờ là cổng public → **bắt buộc**:
- `ValidationPipe` global (`whitelist: true, forbidNonWhitelisted: true, transform: true`).
- `@nestjs/throttler` (rate-limit) + `helmet` + CORS chặt (chỉ origin FE).
- `JwtAuthGuard` mặc định, mở `@Public()` cho login/register/health.
- AI nặng (CV review, roadmap) chạy **async** qua `ai_jobs` (FE poll) để không block request.
- Bí mật (GEMINI/OPENAI key, JWT secret) chỉ trong env; không log; redact text CV khỏi log/trace (PII).

---

## 7. Migration checklist (R0 — thứ tự thực thi, verify từng bước)

> **Trạng thái 2026-05-30 (đã chạy + verify — build/e2e/lint XANH):**
> ✅ **NestJS 10→11** (`--legacy-peer-deps`, e2e ok trên Express 5) · ✅ Gemini→`@google/genai` v2.7 · ✅ `openai` v6.39 · ✅ TypeORM 0.3 + entities (`cvs, users, accounts, sessions, roles, user_roles`) · ✅ **`DatabaseOrmModule.forRoot()` wired vào AppModule** (guard `NODE_ENV!=='test'` để e2e xanh không cần DB) · ✅ **Auth module** `src/platform/auth` (Passport JWT + Google + bcrypt + refresh rotation, `/api/auth/register|login|google|refresh|logout|me`) · ✅ **Public posture** (helmet + CORS + cookie-parser + global ValidationPipe + `@nestjs/throttler` ThrottlerGuard) · ✅ bounded context `src/platform/` đã lập.
> **CÒN LẠI (chặn bởi DB hoặc để tránh phá WIP — KHÔNG phải thiếu code):** ⛔ `migration:generate` + `migration:run` (cần **Postgres chạy** — Docker Desktop đang tắt) · ⛔ verify live DB connection + auth queries (cần Postgres) · 🔁 rename `src/modules/` → `src/ai/` (làm **SAU khi commit WIP** để diff sạch, không trộn rename với WIP) · model nốt entity còn lại + feature gateway `/api/cvs|diagnosis|interview|roadmap` (theo đúng pattern auth) khi có DB.

0. **⚠️ ỔN ĐỊNH WORKING TREE TRƯỚC (BẮT BUỘC).** Repo đang có **refactor dở CHƯA COMMIT** (Phase A.2: `cv-review`/`cv-jd-match`/`roadmap` + parser/dto/prompt sửa dở; file mới chưa track: `cv-parser`, `ats-rule-checker`, `skill-diff`, `course-matcher`, `common/services`, `common/types`, `data/`). Build nhiều khả năng **ĐỎ**. Phải: sửa cho `npm run build` **XANH** → **commit** → rồi MỚI làm các bước dưới. KHÔNG chồng stack-migration lên cây dở (sẽ rối + dễ mất WIP).

1. **Bump core:** NestJS 10→11 + `@nestjs/cli` 11; eslint 8→9 flat config. `npm run build` xanh.
2. **LLM SDK:** gỡ `@google/generative-ai`, thêm `@google/genai`; viết lại `infrastructure/llm/providers/gemini.provider.ts` theo API mới. Bump `openai` ^6, sửa chỗ breaking.
3. **TypeORM:** thêm `@nestjs/typeorm`+`typeorm`+`pgvector`; `data-source.ts` + `TypeOrmModule.forRootAsync`; tạo entity theo DBML (làm trước các bảng R1 cần: `users`, `cvs`, `cv_skills`, `skills`, `role_skill_requirements`, `ai_jobs/requests/results`, `documents`,`document_chunks`); migration đầu. Bỏ raw `pg`.
4. **Auth module** (`platform/auth`): Passport jwt + google, register/login/refresh/logout/me; guard global + `@Public()`.
5. **Public gateway:** chuyển `/internal/ai/*` "internal-only" → có thêm public `/api/*` controllers (cvs, diagnosis, interview, roadmap) + Throttler + Validation.
6. **Reorg thư mục:** `common/`→`shared/`, tách `platform/` & `ai/` bounded contexts; cập nhật path alias.
7. **.env + config schema** theo `.env.example` mới.
8. **Verify:** `npm install && npm run build && npm run lint && npm run test && npm run typeorm migration:run` đều xanh.

> Mỗi bước commit riêng, build xanh mới qua bước sau. Bước 1-2 nên làm trước (gỡ nợ SDK chết + lên NestJS 11), rồi 3 (TypeORM) là xương sống R1.

---

## 8. Sources (verify thư viện 2026-05-30)

- Google GenAI SDK migration — https://ai.google.dev/gemini-api/docs/migrate · deprecated repo: https://github.com/google-gemini/deprecated-generative-ai-js · https://www.npmjs.com/package/@google/genai
- NestJS 11 — https://trilon.io/blog/announcing-nestjs-11-whats-new · https://www.npmjs.com/package/@nestjs/typeorm
- TypeORM + pgvector — https://typeorm.io/docs/drivers/postgres/ · https://www.npmjs.com/package/pgvector
- OpenAI Node SDK — https://github.com/openai/openai-node/releases · https://www.npmjs.com/package/openai

import * as Joi from 'joi';

/**
 * Joi schema for environment variable validation.
 * Service fails fast at startup if any required var is missing/invalid.
 */
export const configValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  PORT: Joi.number().port().default(3002),
  BACKEND_PUBLIC_URL: Joi.string().uri().optional(),
  FRONTEND_BASE_URL: Joi.string().uri().default('http://localhost:8080'),

  INTERNAL_AUTH_SECRET: Joi.string().min(16).required(),

  // API docs
  API_DOCS_ENABLED: Joi.boolean().default(true),
  API_DOCS_PATH: Joi.string().default('reference'),
  OPENAPI_JSON_PATH: Joi.string().default('openapi.json'),

  // Email
  RESEND_API_KEY: Joi.string().when('NODE_ENV', {
    is: 'test',
    then: Joi.string().allow('').optional(),
    otherwise: Joi.string().min(1).required(),
  }),
  RESEND_FROM_EMAIL: Joi.string().when('NODE_ENV', {
    is: 'test',
    then: Joi.string().allow('').optional(),
    otherwise: Joi.string().min(1).required(),
  }),
  EMAIL_VERIFY_TOKEN_TTL_SECONDS: Joi.number().integer().positive().default(86400),

  // LLM
  LLM_PROVIDER_DEFAULT: Joi.string().valid('gemini', 'openai').default('openai'),
  GEMINI_API_KEY: Joi.string().allow('').optional(),
  GEMINI_MODEL_DEFAULT: Joi.string().default('gemini-2.0-flash'),
  GEMINI_MODEL_EMBEDDING: Joi.string().default('text-embedding-004'),
  OPENAI_API_KEY: Joi.string().allow('').optional(),
  OPENAI_MODEL_DEFAULT: Joi.string().default('gpt-5.4-mini'),
  OPENAI_REALTIME_MODEL: Joi.string().default('gpt-realtime-2'),
  OPENAI_TTS_MODEL: Joi.string().default('gpt-4o-mini-tts'),
  OPENAI_TTS_VOICE: Joi.string().default('alloy'),
  OPENAI_MODEL_EMBEDDING: Joi.string().default('text-embedding-3-large'),

  // Database
  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgresql', 'postgres'] })
    .required(),

  // Google Cloud Storage — private CV/avatar storage (ADC auth, no keys).
  GCS_BUCKET: Joi.string().when('NODE_ENV', {
    is: 'test',
    then: Joi.string().allow('').optional(),
    otherwise: Joi.string().min(1).required(),
  }),
  // Optional — on Cloud Run the project is auto-detected from ADC/metadata.
  GCS_PROJECT_ID: Joi.string().allow('').optional(),

  // PDF rendering. Optional; when omitted Puppeteer uses its bundled/default browser.
  PUPPETEER_EXECUTABLE_PATH: Joi.string().allow('').optional(),

  // payOS. Optional at boot so non-billing environments can run; billing flows require these.
  PAYMENT_PROVIDER: Joi.string().default('PAYOS'),
  PAYOS_CLIENT_ID: Joi.string().allow('').optional(),
  PAYOS_API_KEY: Joi.string().allow('').optional(),
  PAYOS_CHECKSUM_KEY: Joi.string().allow('').optional(),
  PAYOS_RETURN_URL: Joi.string().uri().allow('').optional(),
  PAYOS_CANCEL_URL: Joi.string().uri().allow('').optional(),
  PAYOS_WEBHOOK_URL: Joi.string().uri().allow('').optional(),
  PAYOS_PARTNER_CODE: Joi.string().allow('').optional(),

  // Vector — PINNED to 1024: the migration hardcodes skill_embeddings vector(1024), and a
  // mismatched env (e.g. a stale 768 from the old default) would silently kill the semantic
  // tier at query time (pgvector cast error → best-effort catch). Fail fast at boot instead.
  // Changing the width requires a column migration + full re-backfill + version bump.
  VECTOR_DIMENSION: Joi.number().integer().valid(1024).default(1024),
  VECTOR_TABLE: Joi.string().default('document_chunks'),
  VECTOR_COLUMN: Joi.string().default('embedding'),
  VECTOR_EMBEDDING_VERSION: Joi.string().default('v1'),

  // Semantic fallback tier (3-band gate; tuned by pnpm eval:semantic — see configuration.ts)
  SEMANTIC_ACCEPT_THRESHOLD: Joi.number().min(0).max(1).default(0.72),
  SEMANTIC_REVIEW_BAND: Joi.number().min(0).max(0.3).default(0.08),
  SEMANTIC_MAX_PER_CV: Joi.number().integer().min(0).default(16),

  // Observability
  LOG_LEVEL: Joi.string().valid('error', 'warn', 'info', 'debug', 'verbose').default('debug'),
  ENABLE_REQUEST_LOGGING: Joi.boolean().default(true),

  // Auth (JWT + Google) — defaults are DEV ONLY; override in prod.
  JWT_ACCESS_SECRET: Joi.string().min(16).default('dev-access-secret-change-me-please'),
  JWT_ACCESS_TTL: Joi.number().integer().positive().default(3600),
  JWT_REFRESH_SECRET: Joi.string().min(16).default('dev-refresh-secret-change-me-please'),
  JWT_REFRESH_TTL: Joi.number().integer().positive().default(604800),
  GOOGLE_CLIENT_ID: Joi.string().allow('').optional(),
  CORS_ORIGINS: Joi.string().allow('').optional(),

  // DB / TypeORM
  DB_SSL: Joi.boolean().default(false),
  TYPEORM_SYNCHRONIZE: Joi.boolean().default(false),
  TYPEORM_LOGGING: Joi.boolean().default(false),

  // Rate limiting (@nestjs/throttler)
  THROTTLE_TTL: Joi.number().integer().positive().default(60),
  THROTTLE_LIMIT: Joi.number().integer().positive().default(100),

  // Per-user daily cap on CV analyses (cv_review). 0 disables the cap. Enforced by
  // CvAnalysisQuotaGuard against the ai_requests trace (no separate usage table).
  CV_REVIEW_DAILY_LIMIT: Joi.number().integer().min(0).default(5),

  // CV-JD match prompt template. v2 adds JD-Intelligence (jd_dimensions) extraction; v1 is the
  // skill-only legacy path. SERVER-SIDE only (FE never sends it). Default v1 = safe baseline; flip
  // to v2 in code after the A/B drift check, OR via this env on Cloud Run. Joi restricts to the 2
  // valid codes so a typo can never reach prompts.get().
  CV_JD_MATCH_TEMPLATE_CODE: Joi.string()
    .valid('cv_jd_match_v1', 'cv_jd_match_v2')
    .default('cv_jd_match_v1'),
  CV_JD_MATCH_EXTRACTION_CACHE_ENABLED: Joi.boolean().default(true),
  // Phase 2 determinism toggle. Empty/unset = OFF (legacy default model + temp 0.1, byte-identical).
  // Set to a non-reasoning model (e.g. gpt-4o-mini) → temperature-0 (+ optional seed) extraction.
  CV_JD_MATCH_EXTRACTION_MODEL: Joi.string().allow('').default(''),
  CV_JD_MATCH_EXTRACTION_SEED: Joi.number().integer().optional(),

  // Scanned-PDF OCR fallback (input-quality lane). When a PDF's text layer is too thin,
  // rasterize the first N pages with mupdf and OCR them with Tesseract; keep OCR text only
  // when deterministic metrics say it is better. All bounded to protect Cloud Run resources.
  OCR_FALLBACK_ENABLED: Joi.boolean().default(true),
  OCR_FALLBACK_MAX_PAGES: Joi.number().integer().min(1).max(10).default(3),
  OCR_FALLBACK_TIMEOUT_MS: Joi.number().integer().min(1000).default(25000),
  OCR_FALLBACK_MAX_PDF_BYTES: Joi.number().integer().min(1).default(10485760),
  OCR_FALLBACK_DPI: Joi.number().integer().min(72).max(400).default(200),
});

/**
 * Typed configuration loaded from environment variables.
 * Validated via `configValidationSchema` (Joi) on startup.
 */
export default () => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3002', 10),
  frontendBaseUrl: process.env.FRONTEND_BASE_URL ?? 'http://localhost:8080',

  internalAuthSecret: process.env.INTERNAL_AUTH_SECRET ?? '',

  apiDocs: {
    enabled: process.env.API_DOCS_ENABLED !== 'false',
    path: process.env.API_DOCS_PATH ?? 'reference',
    openapiJsonPath: process.env.OPENAPI_JSON_PATH ?? 'openapi.json',
  },

  email: {
    resendApiKey: process.env.RESEND_API_KEY ?? '',
    resendFromEmail: process.env.RESEND_FROM_EMAIL ?? '',
    verifyTokenTtlSeconds: parseInt(process.env.EMAIL_VERIFY_TOKEN_TTL_SECONDS ?? '86400', 10),
  },

  llm: {
    // OpenAI is the standardized text-LLM provider (2026-06-04 decision; Gemini chỉ còn cho
    // Gemini Live voice sau này). Fallback openai để môi trường thiếu env không âm thầm rơi về
    // Gemini free-tier (quota 20/ngày).
    providerDefault: process.env.LLM_PROVIDER_DEFAULT ?? 'openai',
    gemini: {
      apiKey: process.env.GEMINI_API_KEY ?? '',
      modelDefault: process.env.GEMINI_MODEL_DEFAULT ?? 'gemini-2.5-flash',
      modelEmbedding: process.env.GEMINI_MODEL_EMBEDDING ?? 'gemini-embedding-001',
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY ?? '',
      // gpt-5.4-mini = benchmark winner (94% within-band, lowest MAE) — see model-routing memo.
      modelDefault: process.env.OPENAI_MODEL_DEFAULT ?? 'gpt-5.4-mini',
      realtimeModel: process.env.OPENAI_REALTIME_MODEL ?? 'gpt-realtime-2',
      ttsModel: process.env.OPENAI_TTS_MODEL ?? 'gpt-4o-mini-tts',
      ttsVoice: process.env.OPENAI_TTS_VOICE ?? 'alloy',
      // 3-large @1024 dims (Matryoshka) — chosen for bilingual VI/EN short-phrase recall.
      modelEmbedding: process.env.OPENAI_MODEL_EMBEDDING ?? 'text-embedding-3-large',
    },
  },

  database: {
    url: process.env.DATABASE_URL ?? '',
  },

  gcs: {
    bucket: process.env.GCS_BUCKET ?? '',
    projectId: process.env.GCS_PROJECT_ID ?? '',
  },

  payos: {
    provider: process.env.PAYMENT_PROVIDER ?? 'PAYOS',
    clientId: process.env.PAYOS_CLIENT_ID ?? '',
    apiKey: process.env.PAYOS_API_KEY ?? '',
    checksumKey: process.env.PAYOS_CHECKSUM_KEY ?? '',
    returnUrl: process.env.PAYOS_RETURN_URL ?? '',
    cancelUrl: process.env.PAYOS_CANCEL_URL ?? '',
    webhookUrl: process.env.PAYOS_WEBHOOK_URL ?? '',
    partnerCode: process.env.PAYOS_PARTNER_CODE ?? '',
  },

  vector: {
    // MUST match the pgvector column width (skill_embeddings vector(1024)) AND the
    // `dimensions` param sent to OpenAI — the dimension contract (blueprint risk list).
    dimension: parseInt(process.env.VECTOR_DIMENSION ?? '1024', 10),
    table: process.env.VECTOR_TABLE ?? 'document_chunks',
    column: process.env.VECTOR_COLUMN ?? 'embedding',
    // Bumping the version invalidates skill_embeddings rows + the resolution cache.
    embeddingVersion: process.env.VECTOR_EMBEDDING_VERSION ?? 'v1',
  },

  semantic: {
    // 3-band gate for the embedding fallback tier. 0.72 = pnpm eval:semantic pick
    // (2026-06-05, 45 rows): precision 1.000 overall+en+vi, zero negative auto-accepts,
    // 0.04 margin above the closest negative (noise-margin rule ≥0.02). Recall 0.48 —
    // precision-first by design; the review band [accept−0.08, accept) catches the gray zone.
    acceptThreshold: parseFloat(process.env.SEMANTIC_ACCEPT_THRESHOLD ?? '0.72'),
    reviewBandWidth: parseFloat(process.env.SEMANTIC_REVIEW_BAND ?? '0.08'),
    // Per-CV ceiling on semantic resolutions: each cache-miss is one serial OpenAI embed
    // round-trip inside the CV-review request, so a noisy CV (OCR junk) or a cold cache
    // (embedding_version bump) must not turn one request into an unbounded call storm.
    // Overflow mentions still get full deterministic results — review finding.
    maxPerBatch: parseInt(process.env.SEMANTIC_MAX_PER_CV ?? '16', 10),
  },

  observability: {
    logLevel: process.env.LOG_LEVEL ?? 'debug',
    enableRequestLogging: process.env.ENABLE_REQUEST_LOGGING === 'true',
  },

  // Scanned-PDF OCR fallback caps (see validation.ts). enabled default-on; disable with the
  // exact string 'false'. Numerics are Joi-validated/defaulted at boot, so plain reads are safe.
  ocrFallback: {
    enabled: process.env.OCR_FALLBACK_ENABLED !== 'false',
    maxPages: parseInt(process.env.OCR_FALLBACK_MAX_PAGES ?? '3', 10),
    timeoutMs: parseInt(process.env.OCR_FALLBACK_TIMEOUT_MS ?? '25000', 10),
    maxPdfBytes: parseInt(process.env.OCR_FALLBACK_MAX_PDF_BYTES ?? '10485760', 10),
    dpi: parseInt(process.env.OCR_FALLBACK_DPI ?? '200', 10),
  },
});

export type AppConfig = ReturnType<typeof import('./configuration').default>;

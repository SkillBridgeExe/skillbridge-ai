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
    // OpenAI is the standardized text-LLM provider (2026-06-04 decision).
    providerDefault: process.env.LLM_PROVIDER_DEFAULT ?? 'openai',
    openai: {
      apiKey: process.env.OPENAI_API_KEY ?? '',
      // gpt-5.4-mini = benchmark winner (94% within-band, lowest MAE) — see model-routing memo.
      modelDefault: process.env.OPENAI_MODEL_DEFAULT ?? 'gpt-5.4-mini',
      realtimeModel: process.env.OPENAI_REALTIME_MODEL ?? 'gpt-realtime-2',
      realtimeV2Model: process.env.OPENAI_REALTIME_V2_MODEL ?? 'gpt-realtime-2.1',
      realtimeTranscriptionModel:
        process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL ?? 'gpt-4o-mini-transcribe',
      ttsModel: process.env.OPENAI_TTS_MODEL ?? 'gpt-4o-mini-tts',
      ttsVoice: process.env.OPENAI_TTS_VOICE ?? 'marin',
      // 3-large @1024 dims (Matryoshka) — chosen for bilingual VI/EN short-phrase recall.
      modelEmbedding: process.env.OPENAI_MODEL_EMBEDDING ?? 'text-embedding-3-large',
    },
  },

  learning: {
    contentAiEnabled: process.env.LEARNING_CONTENT_AI_ENABLED === 'true',
    contentAiModel: process.env.LEARNING_CONTENT_AI_MODEL ?? '',
    translation: {
      libreUrl: process.env.LEARNING_TRANSLATION_LIBRE_URL ?? process.env.LIBRETRANSLATE_URL ?? '',
      libreApiKey:
        process.env.LEARNING_TRANSLATION_LIBRE_API_KEY ?? process.env.LIBRETRANSLATE_API_KEY ?? '',
      timeoutMs: parseInt(
        process.env.LEARNING_TRANSLATION_TIMEOUT_MS ??
          process.env.LIBRETRANSLATE_TIMEOUT_MS ??
          '5000',
        10,
      ),
      googleEnabled:
        process.env.LEARNING_TRANSLATION_GOOGLE_ENABLED === 'true' ||
        process.env.GOOGLE_TRANSLATE_ENABLED === 'true',
      googleProjectId:
        process.env.LEARNING_TRANSLATION_GOOGLE_PROJECT_ID ??
        process.env.GOOGLE_CLOUD_PROJECT_ID ??
        process.env.GOOGLE_CLOUD_PROJECT ??
        '',
    },
  },

  // CV-JD match prompt template (server-side flip). v1 = skill-only (legacy, byte-identical output);
  // v2 = adds JD-Intelligence (jd_dimensions → jd_intelligence + non-skill gap_items). Joi-validated
  // to v1|v2 at boot. Default v2 = what prod has run via Cloud Run env since 2026-06-16; env stays
  // the rollback lever (set cv_jd_match_v1 to revert without a deploy).
  cvJdMatch: {
    templateCode: process.env.CV_JD_MATCH_TEMPLATE_CODE ?? 'cv_jd_match_v2',
    extractionCacheEnabled: process.env.CV_JD_MATCH_EXTRACTION_CACHE_ENABLED !== 'false',
    // Phase 2 determinism toggle: override model for the EXTRACTION call only. Empty = OFF (use the
    // llm default + temp 0.1, byte-identical legacy). Set to a non-reasoning model (e.g. gpt-4o-mini)
    // to get temperature-0 (+ optional seed) deterministic extraction. Does NOT change scoring.
    extractionModel: process.env.CV_JD_MATCH_EXTRACTION_MODEL ?? '',
    extractionSeed: process.env.CV_JD_MATCH_EXTRACTION_SEED
      ? Number(process.env.CV_JD_MATCH_EXTRACTION_SEED)
      : undefined,
  },

  interviewChain: {
    assessModel: process.env.INTERVIEW_ASSESS_MODEL ?? 'gpt-4o-mini',
    askModel: process.env.INTERVIEW_ASK_MODEL ?? 'gpt-4o-mini',
    answerInsightModel: process.env.ANSWER_INSIGHT_MODEL ?? '',
    coachingModel: process.env.INTERVIEW_COACHING_MODEL ?? '',
  },

  features: {
    interviewRealtimeV2: process.env.INTERVIEW_REALTIME_V2_ENABLED === 'true',
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
    checkoutAllowedOrigins: process.env.PAYOS_CHECKOUT_ALLOWED_ORIGINS ?? '',
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
    // Lower-DPI single retry when the full-DPI attempt times out (dense scans). 0 disables.
    retryDpi: parseInt(process.env.OCR_FALLBACK_RETRY_DPI ?? '120', 10),
  },
});

export type AppConfig = ReturnType<typeof import('./configuration').default>;

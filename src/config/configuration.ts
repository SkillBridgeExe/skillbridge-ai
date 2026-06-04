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
      modelDefault: process.env.OPENAI_MODEL_DEFAULT ?? 'gpt-4o-mini',
      modelEmbedding: process.env.OPENAI_MODEL_EMBEDDING ?? 'text-embedding-3-small',
    },
  },

  database: {
    url: process.env.DATABASE_URL ?? '',
  },

  r2: {
    accountId: process.env.R2_ACCOUNT_ID ?? '',
    bucket: process.env.R2_BUCKET ?? '',
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
  },

  vector: {
    dimension: parseInt(process.env.VECTOR_DIMENSION ?? '768', 10),
    table: process.env.VECTOR_TABLE ?? 'document_chunks',
    column: process.env.VECTOR_COLUMN ?? 'embedding',
  },

  observability: {
    logLevel: process.env.LOG_LEVEL ?? 'debug',
    enableRequestLogging: process.env.ENABLE_REQUEST_LOGGING === 'true',
  },
});

export type AppConfig = ReturnType<typeof import('./configuration').default>;

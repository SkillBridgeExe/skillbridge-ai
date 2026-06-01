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
    providerDefault: process.env.LLM_PROVIDER_DEFAULT ?? 'gemini',
    gemini: {
      apiKey: process.env.GEMINI_API_KEY ?? '',
      modelDefault: process.env.GEMINI_MODEL_DEFAULT ?? 'gemini-2.0-flash',
      modelEmbedding: process.env.GEMINI_MODEL_EMBEDDING ?? 'text-embedding-004',
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

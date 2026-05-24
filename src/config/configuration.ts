/**
 * Typed configuration loaded from environment variables.
 * Validated via `configValidationSchema` (Joi) on startup.
 */
export default () => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3002', 10),

  internalAuthSecret: process.env.INTERNAL_AUTH_SECRET ?? '',

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

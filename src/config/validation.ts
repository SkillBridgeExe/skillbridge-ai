import * as Joi from 'joi';

/**
 * Joi schema for environment variable validation.
 * Service fails fast at startup if any required var is missing/invalid.
 */
export const configValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  PORT: Joi.number().port().default(3002),

  INTERNAL_AUTH_SECRET: Joi.string().min(16).required(),

  // LLM
  LLM_PROVIDER_DEFAULT: Joi.string().valid('gemini', 'openai').default('gemini'),
  GEMINI_API_KEY: Joi.string().allow('').optional(),
  GEMINI_MODEL_DEFAULT: Joi.string().default('gemini-2.0-flash'),
  GEMINI_MODEL_EMBEDDING: Joi.string().default('text-embedding-004'),
  OPENAI_API_KEY: Joi.string().allow('').optional(),
  OPENAI_MODEL_DEFAULT: Joi.string().default('gpt-4o-mini'),
  OPENAI_MODEL_EMBEDDING: Joi.string().default('text-embedding-3-small'),

  // Database
  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgresql', 'postgres'] })
    .required(),

  // Vector
  VECTOR_DIMENSION: Joi.number().integer().positive().default(768),
  VECTOR_TABLE: Joi.string().default('document_chunks'),
  VECTOR_COLUMN: Joi.string().default('embedding'),

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
});

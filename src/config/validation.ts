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

  // Cloudflare R2 private CV storage
  R2_ACCOUNT_ID: Joi.string().when('NODE_ENV', {
    is: 'test',
    then: Joi.string().allow('').optional(),
    otherwise: Joi.string().min(1).required(),
  }),
  R2_BUCKET: Joi.string().when('NODE_ENV', {
    is: 'test',
    then: Joi.string().allow('').optional(),
    otherwise: Joi.string().min(1).required(),
  }),
  R2_ACCESS_KEY_ID: Joi.string().when('NODE_ENV', {
    is: 'test',
    then: Joi.string().allow('').optional(),
    otherwise: Joi.string().min(1).required(),
  }),
  R2_SECRET_ACCESS_KEY: Joi.string().when('NODE_ENV', {
    is: 'test',
    then: Joi.string().allow('').optional(),
    otherwise: Joi.string().min(1).required(),
  }),

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

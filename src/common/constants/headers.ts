/**
 * HTTP header names used across .NET <-> NestJS internal communication.
 */
export const INTERNAL_HEADERS = {
  AUTH: 'x-internal-auth',
  CORRELATION_ID: 'x-correlation-id',
  USER_ID: 'x-user-id',
} as const;

import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { INTERNAL_HEADERS } from '../constants/headers';

/**
 * Extracts the X-Correlation-Id header value as a string parameter.
 *
 * Usage:
 *   handle(@CorrelationId() correlationId: string) { ... }
 */
export const CorrelationId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest<Request>();
    return (request.headers[INTERNAL_HEADERS.CORRELATION_ID] as string) ?? '';
  },
);

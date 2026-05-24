import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { INTERNAL_HEADERS } from '../constants/headers';

/**
 * Extracts the X-User-Id header value (the end user .NET is acting on behalf of).
 *
 * Usage:
 *   handle(@InternalUser() userId: string) { ... }
 */
export const InternalUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest<Request>();
    return (request.headers[INTERNAL_HEADERS.USER_ID] as string) ?? '';
  },
);

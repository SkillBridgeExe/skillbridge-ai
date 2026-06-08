import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { INTERNAL_HEADERS } from '../constants/headers';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * Global guard that requires X-Internal-Auth only for internal AI endpoints.
 * Platform `/api/*` routes use their own JWT/role guards and must not require this shared secret.
 */
@Injectable()
export class InternalAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    if (!isInternalAiRoute(request)) {
      return true;
    }

    const providedSecret = request.headers[INTERNAL_HEADERS.AUTH] as string | undefined;
    const expectedSecret = this.config.get<string>('internalAuthSecret');

    if (!providedSecret || !expectedSecret || providedSecret !== expectedSecret) {
      throw new UnauthorizedException({
        code: 'UNAUTHORIZED',
        message: 'Missing or invalid X-Internal-Auth header',
      });
    }

    return true;
  }
}

function isInternalAiRoute(request: Request): boolean {
  const path =
    request.path ?? request.originalUrl?.split('?')[0] ?? request.url?.split('?')[0] ?? '';
  return path === '/internal/ai' || path.startsWith('/internal/ai/');
}

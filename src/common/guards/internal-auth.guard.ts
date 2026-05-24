import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { INTERNAL_HEADERS } from '../constants/headers';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * Global guard that requires X-Internal-Auth on every request.
 * Routes marked with @Public() bypass this check.
 *
 * Registered as APP_GUARD in AppModule.
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

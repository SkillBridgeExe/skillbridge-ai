import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';
import { INTERNAL_HEADERS } from '../constants/headers';

/**
 * Ensures every request has a correlation ID.
 * - Reuses X-Correlation-Id if .NET sent one
 * - Generates a new UUID v4 otherwise
 * - Echoes the value back in the response header
 * - Logs request start/end with the correlation ID
 */
@Injectable()
export class CorrelationIdInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Request');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    let correlationId = request.headers[INTERNAL_HEADERS.CORRELATION_ID] as string | undefined;
    if (!correlationId) {
      correlationId = uuidv4();
      request.headers[INTERNAL_HEADERS.CORRELATION_ID] = correlationId;
    }
    response.setHeader(INTERNAL_HEADERS.CORRELATION_ID, correlationId);

    const start = Date.now();
    this.logger.log(`-> ${request.method} ${request.url} [cid=${correlationId}]`);

    return next.handle().pipe(
      tap({
        next: () => {
          const ms = Date.now() - start;
          this.logger.log(
            `<- ${request.method} ${request.url} ${response.statusCode} ${ms}ms [cid=${correlationId}]`,
          );
        },
        error: (err) => {
          const ms = Date.now() - start;
          this.logger.warn(
            `<- ${request.method} ${request.url} ERROR ${ms}ms [cid=${correlationId}] ${err?.message ?? err}`,
          );
        },
      }),
    );
  }
}

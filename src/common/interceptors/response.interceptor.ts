import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { map, Observable } from 'rxjs';
import { ApiSuccessResponse } from '../dto/api-response.dto';

/**
 * Wraps every controller return value in the shared success envelope:
 *   { success: true, message: null, data: <returnValue>, errors: null }
 *
 * Shape matches .NET backend's docs/api-response-standard.md so FE sees the
 * same wrapper regardless of which backend produced the response.
 *
 * If a controller returns an object that already has a `success` field, it is
 * returned as-is (escape hatch for special cases like paginated responses with
 * extra `pagination` block).
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, ApiSuccessResponse<T> | T> {
  intercept(
    _context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiSuccessResponse<T> | T> {
    return next.handle().pipe(
      map((data) => {
        if (data && typeof data === 'object' && 'success' in data) {
          return data;
        }
        return {
          success: true,
          message: null,
          data,
          errors: null,
        } as ApiSuccessResponse<T>;
      }),
    );
  }
}

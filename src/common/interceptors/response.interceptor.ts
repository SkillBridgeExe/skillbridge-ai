import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { map, Observable } from 'rxjs';
import { ApiSuccessResponse } from '../dto/api-response.dto';

/**
 * Wraps every controller return value in the standard success envelope:
 *   { success: true, data: <returnValue>, message: null }
 *
 * If a controller returns an object that already has `success` field, it is
 * returned as-is (escape hatch for special cases).
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
          data,
          message: null,
        } as ApiSuccessResponse<T>;
      }),
    );
  }
}

import { ErrorCode } from '../constants/error-codes';

/**
 * Standard success response envelope.
 * The ResponseInterceptor wraps every controller return value in this shape.
 */
export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
  message: string | null;
}

/**
 * Standard error response envelope.
 * The AllExceptionsFilter formats every exception in this shape.
 */
export interface ApiErrorResponse {
  success: false;
  error: {
    code: ErrorCode | string;
    message: string;
    details?: unknown;
  };
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

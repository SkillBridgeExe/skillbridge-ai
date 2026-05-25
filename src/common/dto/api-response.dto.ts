import { ErrorCode } from '../constants/error-codes';

/**
 * Shared response envelope — aligned with .NET backend's docs/api-response-standard.md
 * so .NET and NestJS produce structurally identical responses to FE.
 *
 * .NET shape (canonical):
 *   { success, message, data, errors }
 *
 * NestJS extends this with `errorCode` (machine-readable code for client branching),
 * which .NET has not yet adopted. Proposed addition pending sync with .NET dev.
 */

/**
 * Standard success response envelope.
 * The ResponseInterceptor wraps every controller return value in this shape.
 */
export interface ApiSuccessResponse<T> {
  success: true;
  message: string | null;
  data: T;
  errors: null;
}

/**
 * Standard error response envelope.
 * The AllExceptionsFilter formats every exception in this shape.
 *
 * - `message`: human-readable error text (safe to display).
 * - `errors`: field-keyed object for validation errors; null otherwise.
 *   Example: { "email": ["Email is invalid"] }
 * - `errorCode`: machine-readable code for client branching (NestJS extension).
 */
export interface ApiErrorResponse {
  success: false;
  message: string;
  data: null;
  errors: Record<string, string[]> | null;
  errorCode: ErrorCode | string;
}

/**
 * Paginated success response — extends ApiSuccessResponse with pagination block.
 */
export interface ApiPaginatedResponse<T> extends ApiSuccessResponse<T[]> {
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

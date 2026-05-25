import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ApiErrorResponse } from '../dto/api-response.dto';
import { ERROR_CODES } from '../constants/error-codes';
import { INTERNAL_HEADERS } from '../constants/headers';

/**
 * Global exception filter — produces the shared error envelope:
 *   { success: false, message, data: null, errors: object | null, errorCode }
 *
 * Aligns with .NET backend's docs/api-response-standard.md plus a NestJS-only
 * `errorCode` field for client-side branching. (.NET adoption pending sync.)
 *
 * Behaviors:
 * - HttpException: uses its status + response body. class-validator errors are
 *   reshaped into the field-keyed `errors` object.
 * - Generic Error: 500 + INTERNAL_ERROR.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const correlationId =
      (request.headers[INTERNAL_HEADERS.CORRELATION_ID] as string | undefined) ?? 'unknown';

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let errorCode: string = ERROR_CODES.INTERNAL_ERROR;
    let message = 'Internal server error';
    let errors: Record<string, string[]> | null = null;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
        errorCode = this.statusToCode(status);
      } else if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
        const obj = exceptionResponse as Record<string, unknown>;
        errorCode = (obj.errorCode as string) ?? (obj.code as string) ?? this.statusToCode(status);
        message = typeof obj.message === 'string' ? obj.message : message;

        // class-validator returns `message` as a string[] of error texts
        if (Array.isArray(obj.message)) {
          errorCode = ERROR_CODES.VALIDATION_ERROR;
          message = 'Validation failed';
          errors = this.normalizeValidationErrors(obj.message);
        }

        // If caller explicitly passed an `errors` field-keyed object, use it
        if (
          obj.errors !== undefined &&
          obj.errors !== null &&
          typeof obj.errors === 'object' &&
          !Array.isArray(obj.errors)
        ) {
          errors = obj.errors as Record<string, string[]>;
        }
      }
    } else if (exception instanceof Error) {
      message = exception.message;
    }

    if (status >= 500) {
      this.logger.error(
        `[cid=${correlationId}] ${request.method} ${request.url} -> ${status} ${errorCode} ${message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(
        `[cid=${correlationId}] ${request.method} ${request.url} -> ${status} ${errorCode} ${message}`,
      );
    }

    const body: ApiErrorResponse = {
      success: false,
      message,
      data: null,
      errors,
      errorCode,
    };

    response.status(status).json(body);
  }

  /**
   * class-validator emits an array of strings like:
   *   ["email must be an email", "password must be longer than or equal to 8 characters"]
   * We re-shape it into the field-keyed structure .NET uses:
   *   { email: ["..."], password: ["..."] }
   * Best-effort: extracts first word as field name; falls back to `_` bucket.
   */
  private normalizeValidationErrors(messages: string[]): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const msg of messages) {
      const match = msg.match(/^(\w+)\s/);
      const field = match ? match[1] : '_';
      result[field] = result[field] ?? [];
      result[field].push(msg);
    }
    return result;
  }

  private statusToCode(status: number): string {
    switch (status) {
      case HttpStatus.UNAUTHORIZED:
        return ERROR_CODES.UNAUTHORIZED;
      case HttpStatus.FORBIDDEN:
        return ERROR_CODES.FORBIDDEN;
      case HttpStatus.BAD_REQUEST:
        return ERROR_CODES.VALIDATION_ERROR;
      case HttpStatus.NOT_FOUND:
        return ERROR_CODES.NOT_FOUND;
      case HttpStatus.SERVICE_UNAVAILABLE:
        return ERROR_CODES.AI_SERVICE_UNAVAILABLE;
      case HttpStatus.BAD_GATEWAY:
        return ERROR_CODES.AI_ANALYSIS_FAILED;
      default:
        return ERROR_CODES.INTERNAL_ERROR;
    }
  }
}

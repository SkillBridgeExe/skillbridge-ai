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
 * Global exception filter that formats every error as:
 *   { success: false, error: { code, message, details? } }
 *
 * - HttpException: uses its status + response body
 * - ValidationPipe errors: extracts class-validator messages into details
 * - Unknown errors: 500 + INTERNAL_ERROR
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
    let code: string = ERROR_CODES.INTERNAL_ERROR;
    let message = 'Internal server error';
    let details: unknown = undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
        const obj = exceptionResponse as Record<string, unknown>;
        code = (obj.code as string) ?? this.statusToCode(status);
        message = (obj.message as string) ?? message;
        if (Array.isArray(obj.message)) {
          // class-validator returns an array of strings
          code = ERROR_CODES.VALIDATION_ERROR;
          message = 'Request validation failed';
          details = obj.message;
        }
        if (obj.details !== undefined) {
          details = obj.details;
        }
      }
    } else if (exception instanceof Error) {
      message = exception.message;
    }

    if (status >= 500) {
      this.logger.error(
        `[cid=${correlationId}] ${request.method} ${request.url} -> ${status} ${code} ${message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(
        `[cid=${correlationId}] ${request.method} ${request.url} -> ${status} ${code} ${message}`,
      );
    }

    const body: ApiErrorResponse = {
      success: false,
      error: {
        code,
        message,
        ...(details !== undefined ? { details } : {}),
      },
    };

    response.status(status).json(body);
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

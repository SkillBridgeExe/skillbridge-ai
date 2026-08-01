import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ERROR_CODES } from '../../../common/constants/error-codes';

@Injectable()
export class CheckoutOriginService {
  private readonly allowedOrigins: ReadonlySet<string>;

  constructor(config: ConfigService) {
    const configuredOrigins = parseCsv(config.get<string>('PAYOS_CHECKOUT_ALLOWED_ORIGINS')).map(
      parseConfiguredOrigin,
    );
    this.allowedOrigins = new Set(configuredOrigins);
  }

  resolve(originHeader: string | undefined, refererHeader: string | undefined): string | undefined {
    const origin = originHeader?.trim()
      ? parseBrowserOrigin(originHeader)
      : refererHeader?.trim()
        ? extractUrlOrigin(refererHeader)
        : undefined;

    if (!origin) return undefined;
    if (!this.allowedOrigins.has(origin)) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.VALIDATION_ERROR,
        message: 'Checkout origin is not allowed',
      });
    }
    return origin;
  }
}

function parseCsv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseConfiguredOrigin(value: string): string {
  const url = parseHttpUrl(value);
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('PAYOS_CHECKOUT_ALLOWED_ORIGINS entries must be origins without paths');
  }
  return url.origin;
}

function parseBrowserOrigin(value: string): string {
  const url = parseHttpUrl(value.trim());
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throwInvalidOrigin();
  }
  return url.origin;
}

function extractUrlOrigin(value: string): string {
  return parseHttpUrl(value.trim()).origin;
}

function parseHttpUrl(value: string): URL {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throwInvalidOrigin();
    return url;
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throwInvalidOrigin();
  }
}

function throwInvalidOrigin(): never {
  throw new BadRequestException({
    errorCode: ERROR_CODES.VALIDATION_ERROR,
    message: 'Checkout origin is invalid',
  });
}

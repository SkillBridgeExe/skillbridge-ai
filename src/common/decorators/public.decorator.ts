import { SetMetadata } from '@nestjs/common';

/**
 * Marks a route as public (no X-Internal-Auth required).
 * Currently only used by the health check.
 *
 * Usage:
 *   @Public()
 *   @Get('/health')
 *   healthCheck() { ... }
 */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

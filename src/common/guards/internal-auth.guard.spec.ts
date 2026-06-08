import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { InternalAuthGuard } from './internal-auth.guard';

describe('InternalAuthGuard', () => {
  function guard() {
    return new InternalAuthGuard(
      { getAllAndOverride: jest.fn().mockReturnValue(false) } as unknown as Reflector,
      { get: jest.fn().mockReturnValue('internal-secret') } as unknown as ConfigService,
    );
  }

  function context(path: string, header?: string) {
    return {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: () => ({
        getRequest: () => ({
          path,
          originalUrl: path,
          url: path,
          headers: header ? { 'x-internal-auth': header } : {},
        }),
      }),
    } as never;
  }

  it('does not require X-Internal-Auth for platform API routes', () => {
    expect(guard().canActivate(context('/api/admin/billing/plans'))).toBe(true);
  });

  it('requires X-Internal-Auth for internal AI routes', () => {
    expect(() => guard().canActivate(context('/internal/ai/cv-review'))).toThrow(
      UnauthorizedException,
    );
  });

  it('allows internal AI routes when the shared secret matches', () => {
    expect(guard().canActivate(context('/internal/ai/cv-review', 'internal-secret'))).toBe(true);
  });
});

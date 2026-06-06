import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Global rate-limit guard whose bucket is keyed by the authenticated user when one is
 * present, falling back to the client IP otherwise.
 *
 * Why not the default IP-only tracker:
 *  - IP keying lets a single user circumvent the limit by rotating IPs, and
 *  - it unfairly groups many distinct users behind one shared NAT / campus / cafe IP.
 *
 * Ordering caveat: this is a GLOBAL guard, so on the JWT-protected `/api/*` platform routes
 * it runs BEFORE the controller-scoped `AuthGuard('jwt')` — `req.user` is not populated yet,
 * so those routes fall back to IP here. That is fine: the per-USER cost ceiling on the
 * expensive CV-analysis endpoints is enforced separately by `CvAnalysisQuotaGuard` (method-
 * scoped, runs after auth). For any route where a guard has already set `req.user`, this keys
 * per user as intended, and the implementation is correct the day auth becomes global.
 */
@Injectable()
export class UserAwareThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    const user = req.user as { userId?: string } | undefined;
    const ip =
      (req.ip as string | undefined) ??
      (Array.isArray(req.ips) ? (req.ips[0] as string) : undefined) ??
      'unknown';
    return Promise.resolve(user?.userId ? `user:${user.userId}` : `ip:${ip}`);
  }
}

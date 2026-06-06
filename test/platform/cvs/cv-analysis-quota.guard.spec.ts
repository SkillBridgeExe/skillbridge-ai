import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { CvAnalysisQuotaGuard } from '../../../src/platform/cvs/guards/cv-analysis-quota.guard';
import { ERROR_CODES } from '../../../src/common/constants/error-codes';

/**
 * Unit spec for the per-user daily CV-analysis cap. No DB, no LLM — TracingService and
 * ConfigService are mocked. Asserts the meter only fires when authenticated + enabled, and
 * rejects with the contract 429 once the limit is reached.
 */
function ctxWith(user?: { userId?: string }): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

function build(limit: unknown, used: number) {
  const config = { get: jest.fn().mockReturnValue(limit) };
  const tracing = { countRequestsSince: jest.fn().mockResolvedValue(used) };
  const guard = new CvAnalysisQuotaGuard(tracing as never, config as never);
  return { guard, config, tracing };
}

describe('CvAnalysisQuotaGuard', () => {
  it('allows the request when usage is below the limit, counting cv_review since ICT-midnight', async () => {
    const { guard, tracing } = build(5, 2);
    await expect(guard.canActivate(ctxWith({ userId: 'u1' }))).resolves.toBe(true);
    expect(tracing.countRequestsSince).toHaveBeenCalledTimes(1);
    const [userId, requestType, since] = tracing.countRequestsSince.mock.calls[0];
    expect(userId).toBe('u1');
    expect(requestType).toBe('cv_review');
    expect(since).toBeInstanceOf(Date);
  });

  it('rejects with 429 + CV_ANALYSIS_DAILY_LIMIT_REACHED once the limit is reached', async () => {
    const { guard } = build(5, 5);
    await expect(guard.canActivate(ctxWith({ userId: 'u1' }))).rejects.toThrow(HttpException);
    try {
      await guard.canActivate(ctxWith({ userId: 'u1' }));
    } catch (e) {
      const err = e as HttpException;
      expect(err.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect((err.getResponse() as { errorCode: string }).errorCode).toBe(
        ERROR_CODES.CV_ANALYSIS_DAILY_LIMIT_REACHED,
      );
    }
  });

  it('is disabled (always allows, no DB hit) when the limit is 0', async () => {
    const { guard, tracing } = build(0, 999);
    await expect(guard.canActivate(ctxWith({ userId: 'u1' }))).resolves.toBe(true);
    expect(tracing.countRequestsSince).not.toHaveBeenCalled();
  });

  it('does not meter unauthenticated requests (no user on the request)', async () => {
    const { guard, tracing } = build(5, 999);
    await expect(guard.canActivate(ctxWith(undefined))).resolves.toBe(true);
    expect(tracing.countRequestsSince).not.toHaveBeenCalled();
  });

  it('falls back to the default limit of 5 when the env var is unset', async () => {
    const { guard } = build(undefined, 5); // used 5 ≥ default 5 ⇒ blocked proves default applied
    await expect(guard.canActivate(ctxWith({ userId: 'u1' }))).rejects.toThrow(HttpException);
  });
});

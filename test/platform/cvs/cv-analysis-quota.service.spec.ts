import { HttpException, HttpStatus } from '@nestjs/common';
import { CvAnalysisQuotaService } from '../../../src/platform/cvs/cv-analysis-quota.service';
import { ERROR_CODES } from '../../../src/common/constants/error-codes';

/**
 * Unit spec for the per-user daily CV-analysis cap. No DB, no LLM — TracingService and
 * ConfigService are mocked. The service is called from inside CvsService (after the
 * generated-PDF bypass), so it just meters by counting cv_review since ICT-midnight.
 */
function build(limit: unknown, used: number) {
  const config = { get: jest.fn().mockReturnValue(limit) };
  const tracing = { countRequestsSince: jest.fn().mockResolvedValue(used) };
  const svc = new CvAnalysisQuotaService(tracing as never, config as never);
  return { svc, config, tracing };
}

describe('CvAnalysisQuotaService', () => {
  it('resolves (allows) when usage is below the limit, counting cv_review since ICT-midnight', async () => {
    const { svc, tracing } = build(5, 2);
    await expect(svc.assertWithinDailyLimit('u1')).resolves.toBeUndefined();
    expect(tracing.countRequestsSince).toHaveBeenCalledTimes(1);
    const [userId, requestType, since] = tracing.countRequestsSince.mock.calls[0];
    expect(userId).toBe('u1');
    expect(requestType).toBe('cv_review');
    expect(since).toBeInstanceOf(Date);
  });

  it('throws 429 + CV_ANALYSIS_DAILY_LIMIT_REACHED once the limit is reached', async () => {
    const { svc } = build(5, 5);
    await expect(svc.assertWithinDailyLimit('u1')).rejects.toThrow(HttpException);
    try {
      await svc.assertWithinDailyLimit('u1');
    } catch (e) {
      const err = e as HttpException;
      expect(err.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect((err.getResponse() as { errorCode: string }).errorCode).toBe(
        ERROR_CODES.CV_ANALYSIS_DAILY_LIMIT_REACHED,
      );
    }
  });

  it('is disabled (resolves, no DB hit) when the limit is 0', async () => {
    const { svc, tracing } = build(0, 999);
    await expect(svc.assertWithinDailyLimit('u1')).resolves.toBeUndefined();
    expect(tracing.countRequestsSince).not.toHaveBeenCalled();
  });

  it('does not meter when userId is empty', async () => {
    const { svc, tracing } = build(5, 999);
    await expect(svc.assertWithinDailyLimit('')).resolves.toBeUndefined();
    expect(tracing.countRequestsSince).not.toHaveBeenCalled();
  });

  it('falls back to the default limit of 5 when the env var is unset', async () => {
    const { svc } = build(undefined, 5); // used 5 ≥ default 5 ⇒ blocked proves default applied
    await expect(svc.assertWithinDailyLimit('u1')).rejects.toThrow(HttpException);
  });
});

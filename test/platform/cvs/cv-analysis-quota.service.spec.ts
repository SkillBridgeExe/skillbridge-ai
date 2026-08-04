import { CvAnalysisQuotaService } from '../../../src/platform/cvs/cv-analysis-quota.service';

function build() {
  const reservation = {
    source: 'PLAN' as const,
    eventId: 'evt-1',
    confirm: jest.fn().mockResolvedValue(undefined),
    refund: jest.fn().mockResolvedValue(undefined),
  };
  const usage = {
    reservePlanFirst: jest.fn().mockResolvedValue(reservation),
  };
  const entitlements = {
    getPlanCode: jest.fn(),
    reserveUsage: jest.fn(),
  };
  const svc = new CvAnalysisQuotaService(usage as never, entitlements as never);
  return { svc, usage, reservation };
}

describe('CvAnalysisQuotaService', () => {
  it('delegates the CV review charge to the atomic billing reserve', async () => {
    const { svc, usage, reservation } = build();
    await expect(svc.reserveAnalysis('u1')).resolves.toBe(reservation);
    expect(usage.reservePlanFirst).toHaveBeenCalledWith('u1', 'cv_review');
  });

  it('does not meter when userId is empty', async () => {
    const { svc, usage } = build();
    await expect(svc.reserveAnalysis('')).resolves.toBeNull();
    expect(usage.reservePlanFirst).not.toHaveBeenCalled();
  });
});

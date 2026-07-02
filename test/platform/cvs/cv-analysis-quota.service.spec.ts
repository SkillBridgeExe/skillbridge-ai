import { CvAnalysisQuotaService } from '../../../src/platform/cvs/cv-analysis-quota.service';

function build() {
  const reservation = {
    eventId: 'evt-1',
    confirm: jest.fn().mockResolvedValue(undefined),
    refund: jest.fn().mockResolvedValue(undefined),
  };
  const entitlements = {
    reserveUsage: jest.fn().mockResolvedValue(reservation),
  };
  const svc = new CvAnalysisQuotaService(entitlements as never);
  return { svc, entitlements, reservation };
}

describe('CvAnalysisQuotaService', () => {
  it('delegates the CV review charge to the atomic billing reserve', async () => {
    const { svc, entitlements, reservation } = build();
    await expect(svc.reserveAnalysis('u1')).resolves.toBe(reservation);
    expect(entitlements.reserveUsage).toHaveBeenCalledWith('u1', 'cv_review');
  });

  it('does not meter when userId is empty', async () => {
    const { svc, entitlements } = build();
    await expect(svc.reserveAnalysis('')).resolves.toBeNull();
    expect(entitlements.reserveUsage).not.toHaveBeenCalled();
  });
});

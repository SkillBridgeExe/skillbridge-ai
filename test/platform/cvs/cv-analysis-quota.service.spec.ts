import { CvAnalysisQuotaService } from '../../../src/platform/cvs/cv-analysis-quota.service';

function build() {
  const entitlements = {
    assertCanUse: jest.fn().mockResolvedValue(undefined),
    recordUsage: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new CvAnalysisQuotaService(entitlements as never);
  return { svc, entitlements };
}

describe('CvAnalysisQuotaService', () => {
  it('delegates the CV review gate to billing entitlements', async () => {
    const { svc, entitlements } = build();
    await expect(svc.assertWithinDailyLimit('u1')).resolves.toBeUndefined();
    expect(entitlements.assertCanUse).toHaveBeenCalledWith('u1', 'cv_review');
  });

  it('does not meter when userId is empty', async () => {
    const { svc, entitlements } = build();
    await expect(svc.assertWithinDailyLimit('')).resolves.toBeUndefined();
    expect(entitlements.assertCanUse).not.toHaveBeenCalled();
  });

  it('records successful CV review usage after the model run succeeds', async () => {
    const { svc, entitlements } = build();
    await svc.recordSuccessfulAnalysis('u1', 'cv-1');
    expect(entitlements.recordUsage).toHaveBeenCalledWith('u1', 'cv_review', {
      sourceType: 'cv',
      sourceId: 'cv-1',
    });
  });
});

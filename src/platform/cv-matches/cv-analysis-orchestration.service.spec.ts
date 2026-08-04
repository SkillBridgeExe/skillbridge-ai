import { CvAnalysisQuotaService } from '../cvs/cv-analysis-quota.service';
import { CvsService, PreparedCvAnalysis } from '../cvs/cvs.service';
import { CvAnalysisRequestDto } from './dto/cv-analysis-request.dto';
import { CvAnalysisOrchestrationService } from './cv-analysis-orchestration.service';
import { CvMatchesService } from './cv-matches.service';

function prepared(
  reviewState: PreparedCvAnalysis['reviewState'],
  reservation: PreparedCvAnalysis['reservation'] = null,
): PreparedCvAnalysis {
  return {
    cv: {
      id: 'cv-1',
      review: reviewState === 'NONE' ? null : { overall_score: 78 },
    } as PreparedCvAnalysis['cv'],
    reviewState,
    reservation,
  };
}

function usage(source: 'PLAN' | 'CREDIT' = 'PLAN') {
  return {
    source,
    confirm: jest.fn().mockResolvedValue(undefined),
    refund: jest.fn().mockResolvedValue(undefined),
  };
}

describe('CvAnalysisOrchestrationService', () => {
  function setup() {
    const cvs = {
      createForAnalysis: jest.fn(),
      rerunReviewForAnalysis: jest.fn(),
    } as unknown as jest.Mocked<CvsService>;
    const matches = {
      createMatchWithoutUsageForOrchestration: jest.fn(),
    } as unknown as jest.Mocked<CvMatchesService>;
    const quota = {
      reserveMatch: jest.fn(),
    } as unknown as jest.Mocked<CvAnalysisQuotaService>;
    return {
      service: new CvAnalysisOrchestrationService(cvs, matches, quota),
      cvs,
      matches,
      quota,
    };
  }

  const baseDto: CvAnalysisRequestDto = {
    cvId: '2ef0d936-a6df-499d-805d-e5c09d6c7c47',
    targetRole: 'Backend Developer',
    consentAccepted: true,
  };

  it('returns an exact cached review without charging when no JD is requested', async () => {
    const { service, cvs, quota, matches } = setup();
    cvs.rerunReviewForAnalysis.mockResolvedValue(prepared('CACHED'));

    const result = await service.analyze('user-1', baseDto);

    expect(result.status).toBe('ANALYZED');
    expect(quota.reserveMatch).not.toHaveBeenCalled();
    expect(matches.createMatchWithoutUsageForOrchestration).not.toHaveBeenCalled();
  });

  it('charges one CV match usage when a cached review is combined with a JD', async () => {
    const { service, cvs, quota, matches } = setup();
    const reservation = usage();
    cvs.rerunReviewForAnalysis.mockResolvedValue(prepared('CACHED'));
    quota.reserveMatch.mockResolvedValue(reservation);
    matches.createMatchWithoutUsageForOrchestration.mockResolvedValue({
      id: 'match-1',
    } as never);

    const result = await service.analyze('user-1', { ...baseDto, jdText: 'Build APIs' });

    expect(result.status).toBe('ANALYZED');
    expect(quota.reserveMatch).toHaveBeenCalledWith('user-1');
    expect(reservation.confirm).toHaveBeenCalledWith({
      sourceType: 'cv_match',
      sourceId: 'match-1',
    });
  });

  it('uses the review reservation for review plus JD instead of reserving twice', async () => {
    const { service, cvs, quota, matches } = setup();
    const reservation = usage('CREDIT');
    cvs.rerunReviewForAnalysis.mockResolvedValue(prepared('CREATED', reservation));
    matches.createMatchWithoutUsageForOrchestration.mockResolvedValue({
      id: 'match-1',
    } as never);

    await service.analyze('user-1', { ...baseDto, jdText: 'Build APIs' });

    expect(quota.reserveMatch).not.toHaveBeenCalled();
    expect(reservation.confirm).toHaveBeenCalledTimes(1);
  });

  it('keeps and charges a newly created review when the optional match fails', async () => {
    const { service, cvs, matches } = setup();
    const reservation = usage();
    cvs.rerunReviewForAnalysis.mockResolvedValue(prepared('CREATED', reservation));
    matches.createMatchWithoutUsageForOrchestration.mockRejectedValue(new Error('match failed'));

    const result = await service.analyze('user-1', { ...baseDto, jdText: 'Build APIs' });

    expect(result.status).toBe('REVIEWED_ONLY');
    expect(reservation.confirm).toHaveBeenCalledWith({ sourceType: 'cv', sourceId: 'cv-1' });
    expect(reservation.refund).not.toHaveBeenCalled();
  });

  it('refunds the match reservation when only a cached review existed and matching fails', async () => {
    const { service, cvs, quota, matches } = setup();
    const reservation = usage();
    cvs.rerunReviewForAnalysis.mockResolvedValue(prepared('CACHED'));
    quota.reserveMatch.mockResolvedValue(reservation);
    matches.createMatchWithoutUsageForOrchestration.mockRejectedValue(new Error('match failed'));

    const result = await service.analyze('user-1', { ...baseDto, jdText: 'Build APIs' });

    expect(result.status).toBe('REVIEWED_ONLY');
    expect(reservation.refund).toHaveBeenCalledTimes(1);
    expect(reservation.confirm).not.toHaveBeenCalled();
  });

  it('returns an uploaded-only result without trying to match', async () => {
    const { service, cvs, matches } = setup();
    cvs.rerunReviewForAnalysis.mockResolvedValue(prepared('NONE'));

    const result = await service.analyze('user-1', { ...baseDto, jdText: 'Build APIs' });

    expect(result.status).toBe('UPLOADED_ONLY');
    expect(result.requiredCreditType).toBe('CV_ANALYSIS');
    expect(matches.createMatchWithoutUsageForOrchestration).not.toHaveBeenCalled();
  });
});

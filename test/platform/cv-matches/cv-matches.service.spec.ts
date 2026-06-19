import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CvMatchesService } from '../../../src/platform/cv-matches/cv-matches.service';

describe('CvMatchesService', () => {
  const now = new Date('2026-06-05T00:00:00.000Z');
  const parsedResponse = {
    overall_score: 82,
    match_ratio: 70,
    required_coverage: 0.8,
    matched_skills: [],
    partial_skills: [],
    missing_skills: [],
    bonus_skills: [],
    unnormalized_cv_skills: [],
    unnormalized_jd_requirements: [],
    scoring_breakdown: {
      total_requirements: 10,
      matched_count: 7,
      partial_count: 1,
      missing_count: 2,
      weight_sum: 1,
      achieved_weight: 0.82,
      required_total: 5,
      required_met: 4,
      raw_weighted_score: 82,
      cap_applied: false,
    },
    source_of_requirements: 'jd_extraction' as const,
    target_role: 'frontend_developer',
  };

  function build() {
    const cvsRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: 'cv-1',
        userId: 'user-1',
        parsedText: 'CV parsed text',
        targetRole: 'backend_developer',
        deletedAt: null,
      }),
    };
    const jobDescriptionsRepo = {
      create: jest.fn((input) => input),
      save: jest.fn(async (input) => ({
        id: 'jd-1',
        createdAt: now,
        updatedAt: now,
        ...input,
      })),
    };
    const matchesRepo = {
      create: jest.fn((input) => input),
      save: jest.fn(async (input) => ({
        id: 'match-1',
        createdAt: now,
        ...input,
      })),
      findOne: jest.fn(),
    };
    const scoresRepo = {
      create: jest.fn((input) => input),
      save: jest.fn(async (input) => input),
    };
    const aiResultsRepo = {
      findOne: jest.fn().mockResolvedValue(null),
    };
    const extractor = {
      extract: jest.fn().mockResolvedValue('Extracted JD text'),
    };
    const matcher = {
      match: jest.fn().mockResolvedValue({
        ai_request_id: 'ai-req-1',
        ai_result_id: 'ai-result-1',
        result_type: 'cv_jd_match',
        parsed_response: parsedResponse,
        retrieval_log_id: null,
        retrieved_chunks_count: 0,
        token_usage: 1200,
        latency_ms: 450,
      }),
    };
    const entitlements = {
      assertCanUse: jest.fn().mockResolvedValue(undefined),
      recordUsage: jest.fn().mockResolvedValue(undefined),
    };
    const gapReport = {
      build: jest.fn().mockResolvedValue({
        target_role: 'frontend_developer',
        language: 'vi',
        explicit_gaps: [],
        proficiency_gaps: [],
        evidence_gaps: [],
        recommended_actions: [],
      }),
    };
    const platformCvs = {
      getLatestReview: jest.fn().mockResolvedValue({ evidence_ledger: null }),
    };
    const config = {
      get: jest.fn().mockReturnValue('cv_jd_match_v1'),
    };

    const service = new CvMatchesService(
      cvsRepo as never,
      jobDescriptionsRepo as never,
      matchesRepo as never,
      scoresRepo as never,
      aiResultsRepo as never,
      extractor as never,
      matcher as never,
      entitlements as never,
      gapReport as never,
      platformCvs as never,
      config as never,
    );

    return {
      service,
      cvsRepo,
      jobDescriptionsRepo,
      matchesRepo,
      scoresRepo,
      aiResultsRepo,
      extractor,
      matcher,
      entitlements,
      gapReport,
      platformCvs,
      config,
    };
  }

  it('forwards the configured scoring_template_code to the matcher', async () => {
    const { service, matcher, config } = build();
    config.get.mockReturnValue('cv_jd_match_v2'); // prod flips this via CV_JD_MATCH_TEMPLATE_CODE
    await service.createMatch('user-1', 'cv-1', { jdText: 'JD text here' } as never);
    expect(config.get).toHaveBeenCalledWith('cvJdMatch.templateCode');
    expect(matcher.match).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ scoring_template_code: 'cv_jd_match_v2' }),
    );
  });

  it('persists a pasted JD match and score breakdown for an owned CV', async () => {
    const { service, jobDescriptionsRepo, matchesRepo, scoresRepo, matcher, entitlements } =
      build();

    const response = await service.createMatch('user-1', 'cv-1', {
      jdText: 'We need React and TypeScript experience.',
      title: 'Frontend Developer',
      targetRole: 'frontend_developer',
    });

    expect(jobDescriptionsRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        title: 'Frontend Developer',
        rawText: 'We need React and TypeScript experience.',
        sourceType: 'PASTED',
      }),
    );
    expect(matcher.match).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        cv_id: 'cv-1',
        cv_text: 'CV parsed text',
        jd_id: 'jd-1',
        jd_text: 'We need React and TypeScript experience.',
        scoring_template_code: 'cv_jd_match_v1',
        target_role: 'frontend_developer',
      }),
    );
    expect(matchesRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        cvId: 'cv-1',
        jobDescriptionId: 'jd-1',
        aiResultId: 'ai-result-1',
        targetType: 'JOB_DESCRIPTION',
        overallScore: '82.00',
        semanticScore: '70.00',
        ruleEngineScore: '80.00',
      }),
    );
    expect(scoresRepo.save).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ criteriaName: 'overall_score', score: '82.00' }),
        expect.objectContaining({ criteriaName: 'match_ratio', score: '70.00' }),
        expect.objectContaining({ criteriaName: 'required_coverage', score: '80.00' }),
      ]),
    );
    expect(response).toEqual(
      expect.objectContaining({
        id: 'match-1',
        cvId: 'cv-1',
        jobDescriptionId: 'jd-1',
        aiResultId: 'ai-result-1',
        overallScore: 82,
        matchRatio: 70,
        requiredCoverage: 0.8,
        parsedResponse,
      }),
    );
    expect(entitlements.assertCanUse).toHaveBeenCalledWith('user-1', 'cv_jd_match');
    expect(entitlements.recordUsage).toHaveBeenCalledWith('user-1', 'cv_jd_match', {
      sourceType: 'cv_match',
      sourceId: 'match-1',
    });
  });

  it('does not persist JD or call matcher when CV/JD match quota is denied', async () => {
    const { service, jobDescriptionsRepo, matcher, entitlements } = build();
    entitlements.assertCanUse.mockRejectedValue(new Error('quota denied'));

    await expect(
      service.createMatch('user-1', 'cv-1', {
        jdText: 'We need React and TypeScript experience.',
      }),
    ).rejects.toThrow('quota denied');

    expect(jobDescriptionsRepo.save).not.toHaveBeenCalled();
    expect(matcher.match).not.toHaveBeenCalled();
    expect(entitlements.recordUsage).not.toHaveBeenCalled();
  });

  it('uses uploaded JD text and the CV target role when no override is provided', async () => {
    const { service, extractor, jobDescriptionsRepo, matcher } = build();
    const file = {
      originalname: 'jd.txt',
      mimetype: 'text/plain',
      size: 64,
      buffer: Buffer.from('JD text'),
    } as Express.Multer.File;

    await service.createMatch('user-1', 'cv-1', { title: 'Uploaded JD' }, file);

    expect(extractor.extract).toHaveBeenCalledWith(file);
    expect(jobDescriptionsRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        rawText: 'Extracted JD text',
        sourceType: 'UPLOADED',
      }),
    );
    expect(matcher.match).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ target_role: 'backend_developer' }),
    );
  });

  it('rejects missing or ambiguous JD input', async () => {
    const { service } = build();
    const file = {
      originalname: 'jd.txt',
      mimetype: 'text/plain',
      size: 64,
      buffer: Buffer.from('JD text'),
    } as Express.Multer.File;

    await expect(service.createMatch('user-1', 'cv-1', {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.createMatch('user-1', 'cv-1', { jdText: 'text' }, file),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a CV that is not owned by the user', async () => {
    const { service, cvsRepo } = build();
    cvsRepo.findOne.mockResolvedValue(null);

    await expect(
      service.createMatch('user-1', 'cv-1', { jdText: 'We need React.' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('builds a unified gap report for a match owned through its CV', async () => {
    const { service, matchesRepo, cvsRepo, gapReport, platformCvs } = build();
    matchesRepo.findOne.mockResolvedValue({
      id: 'match-1',
      cvId: 'cv-1',
      overallScore: '82.00',
      semanticScore: '70.00',
      ruleEngineScore: '80.00',
      strengths: parsedResponse.matched_skills,
      weaknesses: [...parsedResponse.partial_skills, ...parsedResponse.missing_skills],
      suggestions: {
        missing_skills: parsedResponse.missing_skills,
        partial_skills: parsedResponse.partial_skills,
        bonus_skills: parsedResponse.bonus_skills,
        scoring_breakdown: parsedResponse.scoring_breakdown,
      },
    });

    const response = await service.getGapReport('user-1', 'match-1', 'vi');

    expect(cvsRepo.findOne).toHaveBeenCalledWith({
      where: { id: 'cv-1', userId: 'user-1', deletedAt: expect.anything() },
    });
    expect(platformCvs.getLatestReview).toHaveBeenCalledWith('user-1', 'cv-1');
    expect(gapReport.build).toHaveBeenCalledWith({
      match: expect.objectContaining({ overall_score: 82 }),
      review: { evidence_ledger: null },
      lang: 'vi',
    });
    expect(response).toEqual(expect.objectContaining({ target_role: 'frontend_developer' }));
  });

  it('returns 404 for gap report when the match is missing', async () => {
    const { service, matchesRepo, gapReport } = build();
    matchesRepo.findOne.mockResolvedValue(null);

    await expect(service.getGapReport('user-1', 'missing', 'vi')).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(gapReport.build).not.toHaveBeenCalled();
  });

  it('returns baseline progress when there is no prior same CV/JD match', async () => {
    const { service, matchesRepo } = build();
    const current = {
      id: 'match-current',
      cvId: 'cv-1',
      jobDescriptionId: 'jd-1',
      createdAt: new Date('2026-06-06T00:00:00.000Z'),
    };
    jest.spyOn(service, 'getGapReport').mockResolvedValue({
      gap_items: [{ canonical_name: 'react', cv_status: 'missing' }],
    } as never);
    matchesRepo.findOne.mockResolvedValueOnce(current).mockResolvedValueOnce(null);

    const out = await service.getProgress('user-1', 'match-current');

    expect(out).toMatchObject({ baseline: true, curr_count: 1, prev_count: 0 });
    expect(matchesRepo.findOne).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ order: { createdAt: 'DESC' } }),
    );
  });

  it('counts only open gaps in baseline progress', async () => {
    const { service, matchesRepo } = build();
    const current = {
      id: 'match-current',
      cvId: 'cv-1',
      jobDescriptionId: 'jd-1',
      createdAt: new Date('2026-06-06T00:00:00.000Z'),
    };
    jest.spyOn(service, 'getGapReport').mockResolvedValue({
      gap_items: [
        { canonical_name: 'react', cv_status: 'matched', severity: 0 },
        { canonical_name: 'sql', cv_status: 'missing', severity: 0.8 },
      ],
    } as never);
    matchesRepo.findOne.mockResolvedValueOnce(current).mockResolvedValueOnce(null);

    const out = await service.getProgress('user-1', 'match-current');

    expect(out).toMatchObject({ baseline: true, curr_count: 1, prev_count: 0 });
  });

  it('diffs progress against the previous same CV/JD match', async () => {
    const { service, matchesRepo } = build();
    const current = {
      id: 'match-current',
      cvId: 'cv-1',
      jobDescriptionId: 'jd-1',
      createdAt: new Date('2026-06-06T00:00:00.000Z'),
    };
    const prior = {
      id: 'match-prior',
      cvId: 'cv-1',
      jobDescriptionId: 'jd-1',
      createdAt: new Date('2026-06-05T00:00:00.000Z'),
    };
    jest
      .spyOn(service, 'getGapReport')
      .mockResolvedValueOnce({
        gap_items: [{ canonical_name: 'react', cv_status: 'matched', severity: 0 }],
      } as never)
      .mockResolvedValueOnce({
        gap_items: [{ canonical_name: 'react', cv_status: 'missing', severity: 0.8 }],
      } as never);
    matchesRepo.findOne.mockResolvedValueOnce(current).mockResolvedValueOnce(prior);

    const out = await service.getProgress('user-1', 'match-current');

    expect(out.baseline).toBe(false);
    expect(out.gaps_closed).toEqual(['react']);
    expect(out.avg_severity_delta).toBe(-0.8);
  });

  /**
   * T9 — parsed-response passthrough. The denormalized match columns (strengths/weaknesses/
   * suggestions) are LOSSY: reconstructing from them hardcodes target_role=null +
   * source_of_requirements='jd_extraction', so every read-path consumer (gap report → market
   * position) saw NO_ROLE even when the match was scored against a role rubric. The
   * full-fidelity parsed_response lives in ai_results — reads must prefer it and only fall
   * back to reconstruction for legacy rows.
   */
  describe('parsed-response passthrough (T9)', () => {
    const fullParsed = {
      ...parsedResponse,
      source_of_requirements: 'role_rubric' as const,
      target_role: 'backend_developer',
      rubric_band: 'fresher' as const,
    };
    const storedMatch = {
      id: 'match-1',
      cvId: 'cv-1',
      jobDescriptionId: null,
      aiResultId: 'ai-result-1',
      overallScore: '82.00',
      semanticScore: '70.00',
      ruleEngineScore: '80.00',
      strengths: [],
      weaknesses: [],
      suggestions: { scoring_breakdown: parsedResponse.scoring_breakdown },
      createdAt: now,
    };

    it('gap report feeds the FULL ai_results parsed_response (target_role, rubric_band) to the builder', async () => {
      const { service, matchesRepo, aiResultsRepo, gapReport } = build();
      matchesRepo.findOne.mockResolvedValue(storedMatch);
      aiResultsRepo.findOne.mockResolvedValue({ id: 'ai-result-1', parsedResponse: fullParsed });

      await service.getGapReport('user-1', 'match-1', 'vi');

      expect(aiResultsRepo.findOne).toHaveBeenCalledWith({ where: { id: 'ai-result-1' } });
      expect(gapReport.build).toHaveBeenCalledWith(
        expect.objectContaining({
          match: expect.objectContaining({
            target_role: 'backend_developer',
            rubric_band: 'fresher',
            source_of_requirements: 'role_rubric',
          }),
        }),
      );
    });

    it('getMatch returns the stored parsed_response instead of the lossy reconstruction', async () => {
      const { service, matchesRepo, aiResultsRepo } = build();
      matchesRepo.findOne.mockResolvedValue(storedMatch);
      aiResultsRepo.findOne.mockResolvedValue({ id: 'ai-result-1', parsedResponse: fullParsed });

      const response = await service.getMatch('user-1', 'cv-1', 'match-1');

      expect(response.parsedResponse).toEqual(fullParsed);
    });

    it('falls back to reconstruction for legacy matches without an aiResultId', async () => {
      const { service, matchesRepo, aiResultsRepo, gapReport } = build();
      matchesRepo.findOne.mockResolvedValue({ ...storedMatch, aiResultId: null });

      await service.getGapReport('user-1', 'match-1', 'vi');

      expect(aiResultsRepo.findOne).not.toHaveBeenCalled();
      expect(gapReport.build).toHaveBeenCalledWith(
        expect.objectContaining({ match: expect.objectContaining({ overall_score: 82 }) }),
      );
    });

    it('falls back to reconstruction when the ai_results row is gone or empty', async () => {
      const { service, matchesRepo, aiResultsRepo, gapReport } = build();
      matchesRepo.findOne.mockResolvedValue(storedMatch);
      aiResultsRepo.findOne.mockResolvedValue({ id: 'ai-result-1', parsedResponse: null });

      await service.getGapReport('user-1', 'match-1', 'vi');

      expect(gapReport.build).toHaveBeenCalledWith(
        expect.objectContaining({ match: expect.objectContaining({ overall_score: 82 }) }),
      );
    });
  });

  /** T7 — seniority band passthrough: the API caller picks the yardstick (never the CV). */
  describe('target band (T7)', () => {
    it('forwards targetBand to the matcher', async () => {
      const { service, matcher } = build();

      await service.createMatch('user-1', 'cv-1', {
        jdText: 'We need React and TypeScript experience.',
        targetBand: 'intern',
      });

      expect(matcher.match).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ target_band: 'intern' }),
      );
    });

    it('omits target_band when the request does not set it (product default stays in the AI module)', async () => {
      const { service, matcher } = build();

      await service.createMatch('user-1', 'cv-1', {
        jdText: 'We need React and TypeScript experience.',
      });

      const input = matcher.match.mock.calls[0][1] as { target_band?: string };
      expect(input.target_band).toBeUndefined();
    });
  });
});

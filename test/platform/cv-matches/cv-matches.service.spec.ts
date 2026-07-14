import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CvMatchesService } from '../../../src/platform/cv-matches/cv-matches.service';
import { jdContentHash } from '../../../src/platform/cv-matches/jd-content-hash';

function progressQueryBuilder(result: unknown) {
  const qb: any = {
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(result),
  };
  return qb;
}

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
      // Default: has a content_hash, so getProgress's lineage lookup proceeds to the
      // query builder (tests override getOne() per-case for baseline vs. diff).
      findOne: jest.fn().mockResolvedValue({ id: 'jd-1', contentHash: 'hash-1' }),
    };
    const matchesQueryBuilder = progressQueryBuilder(null);
    const matchesRepo = {
      create: jest.fn((input) => input),
      save: jest.fn(async (input) => ({
        id: 'match-1',
        createdAt: now,
        ...input,
      })),
      findOne: jest.fn(),
      createQueryBuilder: jest.fn().mockReturnValue(matchesQueryBuilder),
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
    const reservation = {
      eventId: 'usage-1',
      confirm: jest.fn().mockResolvedValue(undefined),
      refund: jest.fn().mockResolvedValue(undefined),
    };
    const entitlements = {
      reserveUsage: jest.fn().mockResolvedValue(reservation),
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
      matchesQueryBuilder,
      scoresRepo,
      aiResultsRepo,
      extractor,
      matcher,
      entitlements,
      reservation,
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
    const {
      service,
      jobDescriptionsRepo,
      matchesRepo,
      scoresRepo,
      matcher,
      entitlements,
      reservation,
    } = build();

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
    expect(entitlements.reserveUsage).toHaveBeenCalledWith('user-1', 'cv_jd_match');
    expect(reservation.confirm).toHaveBeenCalledWith({
      sourceType: 'cv_match',
      sourceId: 'match-1',
    });
    expect(reservation.refund).not.toHaveBeenCalled();
  });

  it('stores the JD content_hash used for progress lineage lookups', async () => {
    const { service, jobDescriptionsRepo } = build();

    await service.createMatch('user-1', 'cv-1', {
      jdText: 'We need React and TypeScript experience.',
    });

    expect(jobDescriptionsRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        contentHash: jdContentHash('We need React and TypeScript experience.'),
      }),
    );
  });

  it('does not persist JD or call matcher when CV/JD match quota is denied', async () => {
    const { service, jobDescriptionsRepo, matcher, entitlements, reservation } = build();
    entitlements.reserveUsage.mockRejectedValue(new Error('quota denied'));

    await expect(
      service.createMatch('user-1', 'cv-1', {
        jdText: 'We need React and TypeScript experience.',
      }),
    ).rejects.toThrow('quota denied');

    expect(jobDescriptionsRepo.save).not.toHaveBeenCalled();
    expect(matcher.match).not.toHaveBeenCalled();
    expect(reservation.confirm).not.toHaveBeenCalled();
  });

  it('refunds the reserved charge when the matcher rejects (e.g. OFF-TOPIC) so junk input stays free', async () => {
    const { service, matcher, reservation } = build();
    matcher.match.mockRejectedValue(new Error('JD_CONTENT_INSUFFICIENT'));

    await expect(
      service.createMatch('user-1', 'cv-1', {
        jdText: 'We need React and TypeScript experience.',
      }),
    ).rejects.toThrow('JD_CONTENT_INSUFFICIENT');

    expect(reservation.refund).toHaveBeenCalledTimes(1);
    expect(reservation.confirm).not.toHaveBeenCalled();
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

  // getProgress no longer routes through the public getGapReport (it needs the raw parsed
  // response too, for template-change detection) — spy on the private
  // loadOwnedMatchParsedResponse/buildGapReportFromParsed/resolveParsedResponse steps instead.
  function stubProgressReportBuilding(
    service: ReturnType<typeof build>['service'],
    opts: {
      current: unknown;
      currParsed?: unknown;
      currGapItems: unknown[];
      prevParsed?: unknown;
      prevGapItems?: unknown[];
    },
  ) {
    jest
      .spyOn(service as never, 'loadOwnedMatchParsedResponse')
      .mockResolvedValue({ match: opts.current, parsed: opts.currParsed ?? {} } as never);
    const buildGapReportFromParsed = jest.spyOn(service as never, 'buildGapReportFromParsed');
    buildGapReportFromParsed.mockResolvedValueOnce({ gap_items: opts.currGapItems } as never);
    if (opts.prevGapItems) {
      buildGapReportFromParsed.mockResolvedValueOnce({ gap_items: opts.prevGapItems } as never);
    }
    if (opts.prevParsed !== undefined) {
      jest
        .spyOn(service as never, 'resolveParsedResponse')
        .mockResolvedValue(opts.prevParsed as never);
    }
    return buildGapReportFromParsed;
  }

  it('returns baseline progress when there is no prior same-user/JD-hash match', async () => {
    const { service, matchesQueryBuilder } = build();
    const current = {
      id: 'match-current',
      cvId: 'cv-1',
      jobDescriptionId: 'jd-1',
      createdAt: new Date('2026-06-06T00:00:00.000Z'),
    };
    stubProgressReportBuilding(service, {
      current,
      currGapItems: [{ canonical_name: 'react', cv_status: 'missing' }],
    });
    matchesQueryBuilder.getOne.mockResolvedValueOnce(null);

    const out = await service.getProgress('user-1', 'match-current');

    expect(out).toMatchObject({ baseline: true, curr_count: 1, prev_count: 0 });
    expect(matchesQueryBuilder.where).toHaveBeenCalledWith('cv.userId = :userId', {
      userId: 'user-1',
    });
    expect(matchesQueryBuilder.andWhere).toHaveBeenCalledWith('jd.contentHash = :hash', {
      hash: 'hash-1',
    });
    expect(matchesQueryBuilder.orderBy).toHaveBeenCalledWith('m.createdAt', 'DESC');
  });

  it('counts only open gaps in baseline progress', async () => {
    const { service, matchesQueryBuilder } = build();
    const current = {
      id: 'match-current',
      cvId: 'cv-1',
      jobDescriptionId: 'jd-1',
      createdAt: new Date('2026-06-06T00:00:00.000Z'),
    };
    stubProgressReportBuilding(service, {
      current,
      currGapItems: [
        { canonical_name: 'react', cv_status: 'matched', severity: 0 },
        { canonical_name: 'sql', cv_status: 'missing', severity: 0.8 },
      ],
    });
    matchesQueryBuilder.getOne.mockResolvedValueOnce(null);

    const out = await service.getProgress('user-1', 'match-current');

    expect(out).toMatchObject({ baseline: true, curr_count: 1, prev_count: 0 });
  });

  it('diffs progress against the previous same-user/JD-hash match (lineage, not raw jobDescriptionId)', async () => {
    const { service, matchesQueryBuilder } = build();
    const current = {
      id: 'match-current',
      cvId: 'cv-1',
      jobDescriptionId: 'jd-1',
      createdAt: new Date('2026-06-06T00:00:00.000Z'),
      overallScore: '80.00',
    };
    const prior = {
      id: 'match-prior',
      cvId: 'cv-1',
      jobDescriptionId: 'jd-0', // different JD row, same content_hash — still lineage
      createdAt: new Date('2026-06-05T00:00:00.000Z'),
      overallScore: '72.00',
    };
    stubProgressReportBuilding(service, {
      current,
      currGapItems: [{ canonical_name: 'react', cv_status: 'matched', severity: 0 }],
      prevParsed: {},
      prevGapItems: [{ canonical_name: 'react', cv_status: 'missing', severity: 0.8 }],
    });
    matchesQueryBuilder.getOne.mockResolvedValueOnce(prior);

    const out = await service.getProgress('user-1', 'match-current');

    expect(out.baseline).toBe(false);
    expect(out.gaps_closed).toEqual(['react']);
    expect(out.avg_severity_delta).toBe(-0.8);
    expect(out.prev_score).toBe(72);
    expect(out.curr_score).toBe(80);
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

    // TRUST' P1: a reconstructed legacy row with NULL scores means "no requirement basis". It must
    // NOT keep claiming source='jd_extraction' (which reads as "scored vs your pasted JD") — that
    // was the exact honest-zero lie. It must surface source='none' + NO_REQUIREMENT_BASIS.
    it("reconstructs a NULL-score legacy row as source='none' + NO_REQUIREMENT_BASIS (never fake jd_extraction)", async () => {
      const { service, matchesRepo, gapReport } = build();
      matchesRepo.findOne.mockResolvedValue({
        ...storedMatch,
        aiResultId: null,
        overallScore: null,
        semanticScore: null,
      });

      await service.getGapReport('user-1', 'match-1', 'vi');

      expect(gapReport.build).toHaveBeenCalledWith(
        expect.objectContaining({
          match: expect.objectContaining({
            overall_score: null,
            match_ratio: null,
            source_of_requirements: 'none',
            degraded_reasons: expect.arrayContaining(['NO_REQUIREMENT_BASIS']),
          }),
        }),
      );
    });

    it('a healthy reconstructed row keeps source=jd_extraction and adds no degraded_reasons', async () => {
      const { service, matchesRepo, gapReport } = build();
      matchesRepo.findOne.mockResolvedValue({ ...storedMatch, aiResultId: null });

      await service.getGapReport('user-1', 'match-1', 'vi');

      const arg = gapReport.build.mock.calls[0][0].match;
      expect(arg.source_of_requirements).toBe('jd_extraction');
      expect(arg.degraded_reasons ?? []).not.toContain('NO_REQUIREMENT_BASIS');
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

  describe('getNextSteps (gap_next_step_advisor)', () => {
    const fullGap = (over: Record<string, unknown>) => ({
      requirement_id: 'jd:hard_skill:x',
      source: 'jd',
      type: 'hard_skill',
      canonical_name: 'x',
      display_name: 'X',
      importance: 'REQUIRED',
      cv_status: 'missing',
      cv_level: null,
      required_level: 3,
      gap_levels: 3,
      satisfied_by: null,
      evidence_refs: [],
      evidence_risk: 'unproven',
      fixability: 'learn',
      market_demand: 50,
      severity: 0.5,
      confidence: 1,
      recommended_next_action: 'do',
      ...over,
    });

    it('returns prioritized next steps from the match gap report (matched gaps excluded)', async () => {
      const { service } = build();
      jest.spyOn(service, 'getGapReport').mockResolvedValue({
        target_role: 'frontend_developer',
        gap_items: [
          fullGap({ canonical_name: 'react', display_name: 'React', cv_status: 'matched' }),
          fullGap({
            canonical_name: 'aws',
            display_name: 'AWS',
            cv_status: 'missing',
            market_demand: 90,
          }),
        ],
      } as never);

      const out = await service.getNextSteps('user-1', 'match-1', 'en');
      expect(out.match_id).toBe('match-1');
      expect(out.target_role).toBe('frontend_developer');
      expect(out.steps.map((s) => s.skill)).toEqual(['AWS']);
      expect(out.steps[0].action).toMatch(/Learn this skill/);
    });
  });

  describe('impact calibration piggyback (ME2)', () => {
    const prior = {
      id: 'match-prior',
      cvId: 'cv-1',
      jobDescriptionId: 'jd-1',
      aiResultId: 'ai-result-prior',
      overallScore: '60.00',
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    };
    const current = {
      id: 'match-current',
      cvId: 'cv-1',
      jobDescriptionId: 'jd-2',
      overallScore: '75.00',
      createdAt: new Date('2026-06-10T00:00:00.000Z'),
    };
    const actionReact = {
      action_id: 'missing_required:react',
      action_type: 'missing_required',
      skill_canonical: 'react',
      expected_impact: { score_min: 5, score_max: 10, severity_drop: null },
    };
    const actionSql = {
      action_id: 'add_evidence:sql',
      action_type: 'add_evidence',
      skill_canonical: 'sql',
      expected_impact: { score_min: 0, score_max: 0, severity_drop: 0.2 },
    };
    const actionAws = {
      action_id: 'missing_required:aws',
      action_type: 'missing_required',
      skill_canonical: 'aws',
      expected_impact: { score_min: 3, score_max: 6, severity_drop: null },
    };
    // No expected_impact — unjoined action; must never produce a fabricated row.
    const actionNode = {
      action_id: 'emphasize:node',
      action_type: 'emphasize',
      skill_canonical: 'node',
    };
    const prevGapItems = [
      { canonical_name: 'react', cv_status: 'missing', severity: 0.8, display_name: 'React' },
      { canonical_name: 'sql', cv_status: 'unproven', severity: 0.5, display_name: 'SQL' },
      { canonical_name: 'aws', cv_status: 'missing', severity: 0.6, display_name: 'AWS' },
    ];
    // 'aws' is entirely absent from curr — the "gone from curr, was open at prior" closed case
    // (gap-progress semantics: it lands in gaps_closed with no per-canonical transition entry).
    const currGapItems = [
      { canonical_name: 'react', cv_status: 'matched', severity: 0, display_name: 'React' },
      { canonical_name: 'sql', cv_status: 'partial', severity: 0.3, display_name: 'SQL' },
    ];

    function buildWithCalibration() {
      const base = build();
      const impactCalibrationsRepo = { manager: { query: jest.fn().mockResolvedValue(undefined) } };
      const aiRequestsRepo = { manager: { query: jest.fn().mockResolvedValue([]) } };
      const service = new CvMatchesService(
        base.cvsRepo as never,
        base.jobDescriptionsRepo as never,
        base.matchesRepo as never,
        base.scoresRepo as never,
        base.aiResultsRepo as never,
        base.extractor as never,
        base.matcher as never,
        base.entitlements as never,
        base.gapReport as never,
        base.platformCvs as never,
        base.config as never,
        undefined, // roadmap
        undefined, // interviewPlan
        undefined, // roadmapComposer
        undefined, // learningPreferences
        undefined, // githubEvidence
        impactCalibrationsRepo as never,
        aiRequestsRepo as never,
      );
      return { ...base, service, impactCalibrationsRepo, aiRequestsRepo };
    }

    function stubRealPrior(
      env: ReturnType<typeof buildWithCalibration>,
      opts: { prevActions: unknown[] },
    ) {
      jest.spyOn(env.service as never, 'loadOwnedMatchParsedResponse').mockResolvedValue({
        match: current,
        parsed: { required_coverage: 0.7 },
      } as never);
      const buildGapReportFromParsed = jest.spyOn(env.service as never, 'buildGapReportFromParsed');
      buildGapReportFromParsed.mockResolvedValueOnce({ gap_items: currGapItems } as never); // curr
      buildGapReportFromParsed.mockResolvedValueOnce({
        gap_items: prevGapItems,
        recommended_actions: opts.prevActions,
      } as never); // prior
      jest
        .spyOn(env.service as never, 'resolveParsedResponse')
        .mockResolvedValue({ required_coverage: 0.5 } as never);
      env.matchesQueryBuilder.getOne.mockResolvedValueOnce(prior);
      // Real (non-lossy) ai_results row for the prior match.
      env.aiResultsRepo.findOne.mockResolvedValue({
        id: 'ai-result-prior',
        parsedResponse: { some: 'thing' },
      });
      return buildGapReportFromParsed;
    }

    it('writes one row per scan-N action with expected_impact, with predicted/actual/transition and attempted joined; skips unjoined actions', async () => {
      const env = buildWithCalibration();
      stubRealPrior(env, { prevActions: [actionReact, actionSql, actionAws, actionNode] });
      env.aiRequestsRepo.manager.query.mockResolvedValue([{ action_id: 'missing_required:react' }]);

      const out = await env.service.getProgress('user-1', 'match-current');

      expect(out.baseline).toBe(false);
      expect(env.aiRequestsRepo.manager.query).toHaveBeenCalledTimes(1);
      expect(env.aiRequestsRepo.manager.query).toHaveBeenCalledWith(
        expect.stringContaining("request_type = 'cv_rewrite'"),
        [
          'user-1',
          prior.createdAt,
          current.createdAt,
          prior.id,
          [actionReact.action_id, actionSql.action_id, actionAws.action_id],
        ],
      );
      // Pins the read to go through TracingService's payload wrapper
      // (request_payload.payload.action_id) — a plain request_payload ->> 'action_id'
      // would never match a real row and silently always return attempted=false.
      expect(env.aiRequestsRepo.manager.query.mock.calls[0][0]).toEqual(
        expect.stringContaining("-> 'payload' ->> 'action_id'"),
      );

      const insert = env.impactCalibrationsRepo.manager.query;
      expect(insert).toHaveBeenCalledTimes(3); // react, sql, aws — node has no expected_impact
      expect(insert).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('ON CONFLICT (prior_match_id, current_match_id, canonical_name)'),
        [
          'user-1',
          'match-prior',
          'match-current',
          'hash-1',
          'react',
          'missing_required',
          5,
          10,
          null,
          15,
          -0.8,
          'closed',
          true,
        ],
      );
      expect(insert).toHaveBeenNthCalledWith(2, expect.any(String), [
        'user-1',
        'match-prior',
        'match-current',
        'hash-1',
        'sql',
        'add_evidence',
        0,
        0,
        0.2,
        15,
        -0.2,
        'improved',
        false,
      ]);
      expect(insert).toHaveBeenNthCalledWith(3, expect.any(String), [
        'user-1',
        'match-prior',
        'match-current',
        'hash-1',
        'aws',
        'missing_required',
        3,
        6,
        null,
        15,
        null,
        'closed',
        false,
      ]);
    });

    it('is idempotent-by-construction: a second getProgress call for the same scan pair issues the same ON CONFLICT DO NOTHING insert', async () => {
      const env = buildWithCalibration();
      stubRealPrior(env, { prevActions: [actionReact] });

      await env.service.getProgress('user-1', 'match-current');
      const firstCallSql = env.impactCalibrationsRepo.manager.query.mock.calls[0][0];
      expect(firstCallSql).toContain('DO NOTHING');

      // Re-stub for a second identical call (mockResolvedValueOnce chains were consumed).
      stubRealPrior(env, { prevActions: [actionReact] });
      await env.service.getProgress('user-1', 'match-current');

      expect(env.impactCalibrationsRepo.manager.query).toHaveBeenCalledTimes(2);
      expect(env.impactCalibrationsRepo.manager.query.mock.calls[1][0]).toContain('DO NOTHING');
    });

    it('skips entirely (no rows, warns) when the prior parsed_response was reconstructed via the lossy fallback', async () => {
      const env = buildWithCalibration();
      stubRealPrior(env, { prevActions: [actionReact] });
      env.aiResultsRepo.findOne.mockResolvedValue(null); // no aiResultId row → lossy reconstruction
      const logger = (env.service as unknown as { logger: { warn: jest.Mock } }).logger;
      jest.spyOn(logger, 'warn');

      const out = await env.service.getProgress('user-1', 'match-current');

      expect(out.baseline).toBe(false); // progress itself is unaffected
      expect(env.impactCalibrationsRepo.manager.query).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('lossy'));
    });

    it('skips entirely (no rows, warns) when the scoring template changed between scans', async () => {
      const env = buildWithCalibration();
      jest.spyOn(env.service as never, 'loadOwnedMatchParsedResponse').mockResolvedValue({
        match: current,
        parsed: { required_coverage: 0.7, jd_dimensions: [] }, // curr is v2
      } as never);
      const buildGapReportFromParsed = jest.spyOn(env.service as never, 'buildGapReportFromParsed');
      buildGapReportFromParsed.mockResolvedValueOnce({ gap_items: currGapItems } as never);
      buildGapReportFromParsed.mockResolvedValueOnce({
        gap_items: prevGapItems,
        recommended_actions: [actionReact],
      } as never);
      jest
        .spyOn(env.service as never, 'resolveParsedResponse')
        .mockResolvedValue({ required_coverage: 0.5 } as never); // prior predates jd_dimensions (v1)
      env.matchesQueryBuilder.getOne.mockResolvedValueOnce(prior);
      env.aiResultsRepo.findOne.mockResolvedValue({
        id: 'ai-result-prior',
        parsedResponse: { some: 'thing' },
      });
      const logger = (env.service as unknown as { logger: { warn: jest.Mock } }).logger;
      jest.spyOn(logger, 'warn');

      const out = await env.service.getProgress('user-1', 'match-current');

      expect(out.template_changed).toBe(true);
      expect(env.impactCalibrationsRepo.manager.query).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('template changed'));
    });

    it('never throws when the calibration insert fails — the real diff progress is still returned', async () => {
      const env = buildWithCalibration();
      stubRealPrior(env, { prevActions: [actionReact, actionSql] });
      env.impactCalibrationsRepo.manager.query.mockRejectedValue(new Error('db down'));
      const logger = (env.service as unknown as { logger: { warn: jest.Mock } }).logger;
      jest.spyOn(logger, 'warn');

      const out = await env.service.getProgress('user-1', 'match-current');

      expect(out.baseline).toBe(false);
      expect(out.gaps_closed).toContain('react');
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('write failed'));
    });

    it('marks attempted=false when no matching cv_rewrite trace exists in the scan window', async () => {
      const env = buildWithCalibration();
      stubRealPrior(env, { prevActions: [actionReact] });
      env.aiRequestsRepo.manager.query.mockResolvedValue([]); // no trace at all

      await env.service.getProgress('user-1', 'match-current');

      expect(env.impactCalibrationsRepo.manager.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([false]),
      );
      const params = env.impactCalibrationsRepo.manager.query.mock.calls[0][1] as unknown[];
      expect(params[params.length - 1]).toBe(false);
    });

    it('scopes attempted traces to the prior match_id so the same action_id from another match cannot contaminate calibration', async () => {
      const env = buildWithCalibration();
      stubRealPrior(env, { prevActions: [actionReact] });

      await env.service.getProgress('user-1', 'match-current');

      expect(env.aiRequestsRepo.manager.query.mock.calls[0][0]).toEqual(
        expect.stringContaining("request_payload -> 'payload' ->> 'match_id' = $4"),
      );
      expect(env.aiRequestsRepo.manager.query.mock.calls[0][1]).toEqual([
        'user-1',
        prior.createdAt,
        current.createdAt,
        prior.id,
        [actionReact.action_id],
      ]);
    });
  });
});

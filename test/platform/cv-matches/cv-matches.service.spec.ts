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

    const service = new CvMatchesService(
      cvsRepo as never,
      jobDescriptionsRepo as never,
      matchesRepo as never,
      scoresRepo as never,
      extractor as never,
      matcher as never,
    );

    return { service, cvsRepo, jobDescriptionsRepo, matchesRepo, scoresRepo, extractor, matcher };
  }

  it('persists a pasted JD match and score breakdown for an owned CV', async () => {
    const { service, jobDescriptionsRepo, matchesRepo, scoresRepo, matcher } = build();

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
});

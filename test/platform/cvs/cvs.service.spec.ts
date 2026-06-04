import { CvsService } from '../../../src/platform/cvs/cvs.service';

describe('CvsService R1 completion behavior', () => {
  const now = new Date('2026-06-04T00:00:00.000Z');
  const parsedReview = {
    language: 'vi',
    document: {
      language: 'vi',
      contact: { name: null, email: null, phone: null, location: null, links: [] },
      summary: '',
      education: [],
      experience: [],
      projects: [],
      skills: { technical: [], soft: [], languages: [], tools: [] },
      certifications: [],
      activities: [],
    },
    overall_score: 82,
    ats_rule_score: 80,
    ats_check: { ats_rule_score: 80, summary: { failed: 0, total: 1 }, rules: [] },
    llm_score_dimensions: {
      action_verbs: 16,
      skills_relevance: 15,
      experience: 15,
      education: 14,
    },
    llm_total: 60,
    llm_normalized: 75,
    rationale: {
      action_verbs: '',
      skills_relevance: '',
      experience: '',
      education: '',
    },
    sections: [],
    ats_extracted: { name: null, email: null, phone: null, skills_raw: [] },
    parsed_cv: { name: null, email: null, phone: null, skills_raw: [] },
    action_verbs_analysis: {
      bulletCount: 0,
      verbFirstRatio: 0,
      quantifiedRatio: 0,
      weakOpenerRatio: 0,
      firstPersonRatio: 0,
      fillerCount: 0,
      actionVerbsScore: 0,
      band: 'missing',
      notes: [],
    },
    scoring_weights_version: 'scoring-weights-v1',
  };

  function build() {
    const cvsRepo = {
      create: jest.fn((input) => ({ ...input, createdAt: now, updatedAt: now })),
      save: jest.fn(async (input) => ({
        ...input,
        createdAt: input.createdAt ?? now,
        updatedAt: now,
      })),
      findOne: jest.fn(),
      findAndCount: jest.fn(),
      softDelete: jest.fn(),
    };
    const cvSkillsRepo = {
      find: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue(undefined),
      create: jest.fn((input) => input),
      save: jest.fn().mockResolvedValue(undefined),
    };
    const skillsRepo = {
      find: jest.fn().mockResolvedValue([]),
    };
    const storage = {
      buildCvObjectKey: jest.fn().mockReturnValue('cvs/u1/cv-1/sample.pdf'),
      upload: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      download: jest.fn(),
    };
    const extractor = {
      extract: jest.fn().mockResolvedValue({ text: 'parsed cv text', isOcrOnly: false }),
    };
    const cvReview = {
      review: jest.fn().mockResolvedValue({ parsed_response: parsedReview }),
    };
    const skillNormalizer = {
      // cvs.service uses the async variant (deterministic cascade + semantic fallback tier).
      normalizeManyAsync: jest.fn().mockResolvedValue([]),
    };
    const consentAudits = {
      create: jest.fn((input) => input),
      save: jest.fn().mockResolvedValue(undefined),
    };
    const aiResults = {
      manager: {
        query: jest.fn().mockResolvedValue([]),
      },
    };

    const service = new CvsService(
      cvsRepo as never,
      cvSkillsRepo as never,
      skillsRepo as never,
      storage as never,
      extractor as never,
      cvReview as never,
      skillNormalizer as never,
      consentAudits as never,
      aiResults as never,
    );

    return {
      service,
      cvsRepo,
      cvSkillsRepo,
      skillsRepo,
      storage,
      cvReview,
      skillNormalizer,
      consentAudits,
      aiResults,
    };
  }

  const file = {
    originalname: 'sample.pdf',
    mimetype: 'application/pdf',
    size: 1024,
    buffer: Buffer.from('%PDF-1.4'),
  } as Express.Multer.File;

  it('persists targetRole on upload and records consent audit', async () => {
    const { service, cvsRepo, consentAudits } = build();

    await service.create(
      'u1',
      { title: 'Frontend CV', targetRole: 'frontend_developer', consentAccepted: true },
      file,
    );

    expect(cvsRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        targetRole: 'frontend_developer',
      }),
    );
    expect(consentAudits.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        cvId: expect.any(String),
        consentVersion: 'cv-processing-v1',
        consentSource: 'cv_upload',
        acceptedAt: expect.any(Date),
      }),
    );
    expect(consentAudits.save).toHaveBeenCalled();
  });

  it('reuses the persisted targetRole when rerunning review', async () => {
    const { service, cvsRepo, cvReview } = build();
    cvsRepo.findOne.mockResolvedValue({
      id: 'cv-1',
      userId: 'u1',
      parsedText: 'parsed cv text',
      fileType: 'application/pdf',
      isOcrOnly: false,
      targetRole: 'backend_developer',
      createdAt: now,
      updatedAt: now,
    });

    await service.rerunReview('u1', 'cv-1');

    expect(cvReview.review).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({
        cv_id: 'cv-1',
        target_role: 'backend_developer',
      }),
    );
  });

  it('returns the latest persisted cv_review result when fetching CV detail', async () => {
    const { service, cvsRepo, aiResults } = build();
    cvsRepo.findOne.mockResolvedValue({
      id: 'cv-1',
      userId: 'u1',
      title: 'CV',
      originalFileName: 'sample.pdf',
      fileType: 'application/pdf',
      fileSize: 1024,
      parsedText: 'parsed cv text',
      parsedJson: null,
      cvKind: 'UPLOADED',
      language: 'vi',
      isOcrOnly: false,
      atsReadabilityScore: '80.00',
      targetRole: 'frontend_developer',
      createdAt: now,
      updatedAt: now,
    });
    aiResults.manager.query.mockResolvedValue([{ parsed_response: parsedReview }]);

    const response = await service.get('u1', 'cv-1');

    expect(response.review).toEqual(parsedReview);
    expect(aiResults.manager.query).toHaveBeenCalledWith(expect.stringContaining('ai_results'), [
      'u1',
      'cv-1',
    ]);
  });

  it('persists each normalized skill only once when multiple raw skills map to the same canonical skill', async () => {
    const { service, cvSkillsRepo, cvReview, skillNormalizer, skillsRepo } = build();
    cvReview.review.mockResolvedValue({
      parsed_response: {
        ...parsedReview,
        ats_extracted: {
          ...parsedReview.ats_extracted,
          skills_raw: ['React', 'React.js'],
        },
      },
    });
    skillNormalizer.normalizeManyAsync.mockResolvedValue([
      {
        canonical_name: 'react',
        display_name: 'React',
        raw_input: 'React',
        matched_via: 'exact',
        confidence: 1,
      },
      {
        canonical_name: 'react',
        display_name: 'React',
        raw_input: 'React.js',
        matched_via: 'alias',
        confidence: 0.95,
      },
    ]);
    skillsRepo.find.mockResolvedValue([
      {
        id: 'skill-react',
        canonicalName: 'react',
        displayName: 'React',
      },
    ]);

    await service.create(
      'u1',
      { title: 'Frontend CV', targetRole: 'frontend_developer', consentAccepted: true },
      file,
    );

    expect(cvSkillsRepo.save).toHaveBeenCalledWith([
      {
        cvId: expect.any(String),
        skillId: 'skill-react',
        confidence: '1.00',
      },
    ]);
  });
});

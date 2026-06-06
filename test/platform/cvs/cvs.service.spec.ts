import { BadRequestException, NotFoundException } from '@nestjs/common';
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
      count: jest.fn().mockResolvedValue(0),
      softDelete: jest.fn(),
      update: jest.fn(),
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
    const evaluator = {
      evaluate: jest.fn().mockReturnValue({ score: 88, label: 'Good', checklist: [], missing: [] }),
    };
    const rewriter = {
      rewrite: jest.fn().mockResolvedValue({ suggestion: 'Improved text' }),
    };
    const pdfRenderer = {
      extractSkillbridgeFingerprint: jest.fn().mockResolvedValue(null),
      renderHarvardPdf: jest.fn().mockResolvedValue({
        buffer: Buffer.from('%PDF-1.7 rendered'),
        fileName: 'cv-builder.pdf',
      }),
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
      evaluator as never,
      rewriter as never,
      pdfRenderer as never,
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
      evaluator,
      rewriter,
      pdfRenderer,
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

  it('creates a BUILT builder draft from an explicitly owned source CV parsedJson', async () => {
    const { service, cvsRepo, storage, cvReview } = build();
    const sourceDocument = parsedReview.document;
    cvsRepo.findOne.mockResolvedValue({
      id: 'source-cv',
      userId: 'u1',
      parsedJson: sourceDocument,
      cvKind: 'UPLOADED',
      targetRole: 'frontend_developer',
      language: 'vi',
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    const response = await service.createBuilderDraft('u1', {
      sourceCvId: 'source-cv',
      title: 'Builder Draft',
    });

    expect(cvsRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        title: 'Builder Draft',
        cvKind: 'BUILT',
        parsedJson: sourceDocument,
        fileUrl: null,
        parsedText: null,
        targetRole: 'frontend_developer',
        language: 'vi',
      }),
    );
    expect(storage.upload).not.toHaveBeenCalled();
    expect(cvReview.review).not.toHaveBeenCalled();
    expect(response.cvKind).toBe('BUILT');
    expect(response.parsedJson).toEqual(sourceDocument);
  });

  it('creates a blank BUILT builder draft when no parsed upload exists', async () => {
    const { service, cvsRepo } = build();
    cvsRepo.findOne.mockResolvedValue(null);

    const response = await service.createBuilderDraft('u1', { language: 'en' });

    expect(cvsRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 'u1', cvKind: 'UPLOADED' }),
        order: { createdAt: 'DESC' },
      }),
    );
    expect(response.cvKind).toBe('BUILT');
    expect(response.parsedJson).toEqual(
      expect.objectContaining({
        language: 'en',
        contact: expect.objectContaining({ links: [] }),
        experience: [],
      }),
    );
  });

  it('autosaves parsedJson only for an owned BUILT CV', async () => {
    const { service, cvsRepo } = build();
    const draft = {
      id: 'draft-1',
      userId: 'u1',
      title: 'Draft',
      parsedJson: null,
      cvKind: 'BUILT',
      language: 'en',
      targetRole: null,
      createdAt: now,
      updatedAt: now,
    };
    cvsRepo.findOne.mockResolvedValue(draft);

    await service.updateBuilderDraft('u1', 'draft-1', {
      parsedJson: parsedReview.document,
      title: 'Updated Draft',
      targetRole: 'backend_developer',
    });

    expect(cvsRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'draft-1',
        parsedJson: parsedReview.document,
        title: 'Updated Draft',
        targetRole: 'backend_developer',
      }),
    );
  });

  it('rejects autosave for an uploaded CV', async () => {
    const { service, cvsRepo } = build();
    cvsRepo.findOne.mockResolvedValue({
      id: 'cv-1',
      userId: 'u1',
      cvKind: 'UPLOADED',
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      service.updateBuilderDraft('u1', 'cv-1', { parsedJson: parsedReview.document }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('delegates builder section evaluation and rewrite after ownership check', async () => {
    const { service, cvsRepo, evaluator, rewriter } = build();
    cvsRepo.findOne.mockResolvedValue({
      id: 'draft-1',
      userId: 'u1',
      cvKind: 'BUILT',
      createdAt: now,
      updatedAt: now,
    });

    const evaluateBody = { section: 'summary' as const, content: { summary: 'Built APIs' } };
    const rewriteBody = { text: 'Built APIs', mode: 'harvard' as const };

    await service.evaluateBuilderSection('u1', 'draft-1', evaluateBody);
    await service.rewriteBuilderText('u1', 'draft-1', rewriteBody);

    expect(evaluator.evaluate).toHaveBeenCalledWith(evaluateBody);
    expect(rewriter.rewrite).toHaveBeenCalledWith(rewriteBody);
  });

  it('renders a BUILT CV PDF from parsedJson without storage persistence', async () => {
    const { service, cvsRepo, pdfRenderer, storage } = build();
    const draft = {
      id: 'draft-1',
      userId: 'u1',
      title: 'Draft',
      parsedJson: parsedReview.document,
      cvKind: 'BUILT',
      createdAt: now,
      updatedAt: now,
    };
    cvsRepo.findOne.mockResolvedValue(draft);

    const rendered = await service.renderPdf('u1', 'draft-1');

    expect(pdfRenderer.renderHarvardPdf).toHaveBeenCalledWith(draft);
    expect(storage.upload).not.toHaveBeenCalled();
    expect(rendered.buffer).toEqual(Buffer.from('%PDF-1.7 rendered'));
  });

  it('skips parsing and scoring when uploaded PDF has a SkillBridge fingerprint owned by the user', async () => {
    const { service, cvsRepo, pdfRenderer, storage, cvReview } = build();
    const ownedCv = {
      id: 'original-cv',
      userId: 'u1',
      title: 'Original',
      originalFileName: null,
      fileType: null,
      fileSize: null,
      parsedText: null,
      parsedJson: parsedReview.document,
      cvKind: 'BUILT',
      language: 'vi',
      isOcrOnly: false,
      atsReadabilityScore: null,
      targetRole: null,
      createdAt: now,
      updatedAt: now,
    };
    pdfRenderer.extractSkillbridgeFingerprint.mockResolvedValue('original-cv');
    cvsRepo.findOne.mockResolvedValue(ownedCv);

    const response = await service.create(
      'u1',
      { consentAccepted: true },
      { ...file, buffer: Buffer.from('%PDF-1.7 generated') },
    );

    expect(response.id).toBe('original-cv');
    expect(storage.upload).not.toHaveBeenCalled();
    expect(cvReview.review).not.toHaveBeenCalled();
    expect(cvsRepo.count).not.toHaveBeenCalled();
  });

  it('enforces 10 real CV uploads per rolling day', async () => {
    const { service, cvsRepo, storage } = build();
    cvsRepo.count.mockResolvedValue(10);

    await expect(service.create('u1', { consentAccepted: true }, file)).rejects.toMatchObject({
      response: expect.objectContaining({ errorCode: 'CV_UPLOAD_QUOTA_EXCEEDED' }),
    });
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('returns a privacy-policy 404 when the stored file has been cleaned up', async () => {
    const { service, cvsRepo } = build();
    cvsRepo.findOne.mockResolvedValue({
      id: 'cv-1',
      userId: 'u1',
      fileUrl: null,
      cvKind: 'UPLOADED',
      createdAt: now,
      updatedAt: now,
    });

    await expect(service.download('u1', 'cv-1')).rejects.toMatchObject({
      response: expect.objectContaining({
        message: 'Original CV file is no longer stored under the privacy retention policy',
      }),
    });
  });

  it('rejects builder APIs for a CV not owned by the user', async () => {
    const { service, cvsRepo } = build();
    cvsRepo.findOne.mockResolvedValue(null);

    await expect(
      service.createBuilderDraft('u1', { sourceCvId: 'someone-else' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

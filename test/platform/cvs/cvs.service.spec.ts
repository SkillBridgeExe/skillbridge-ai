import { BadRequestException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { BillingFeatureKey } from '../../../src/common/constants/billing.constants';
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
        id: input.id ?? 'saved-cv',
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
    // Per-user daily cv_review cap — default no-op; tests override to assert enforcement points.
    const analysisQuota = {
      assertWithinDailyLimit: jest.fn().mockResolvedValue(undefined),
      recordSuccessfulAnalysis: jest.fn().mockResolvedValue(undefined),
    };
    const entitlements = {
      assertCanUse: jest.fn().mockResolvedValue(undefined),
      recordUsage: jest.fn().mockResolvedValue(undefined),
    };
    const interviewPlan = {
      generatePlan: jest.fn().mockResolvedValue({
        target_role: 'frontend_developer',
        language: 'vi',
        items: [],
        llm_enhanced: false,
        token_usage: 0,
      }),
    };
    const githubEvidence = {
      build: jest.fn().mockResolvedValue({ available: false, reason: 'CONSENT_REQUIRED' }),
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
      analysisQuota as never,
      entitlements as never,
      interviewPlan as never,
      githubEvidence as never,
    );

    return {
      service,
      cvsRepo,
      cvSkillsRepo,
      skillsRepo,
      storage,
      extractor,
      cvReview,
      skillNormalizer,
      consentAudits,
      aiResults,
      evaluator,
      rewriter,
      pdfRenderer,
      analysisQuota,
      entitlements,
      interviewPlan,
      githubEvidence,
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
      BillingFeatureKey.CV_REVIEW,
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

  it('enforces and records the builder create quota around successful draft creation', async () => {
    const { service, cvsRepo, entitlements } = build();
    cvsRepo.findOne.mockResolvedValue(null);

    const response = await service.createBuilderDraft('u1', { language: 'en' });

    expect(entitlements.assertCanUse).toHaveBeenCalledWith('u1', 'cv_builder_create');
    expect(response.id).toBe('saved-cv');
    expect(entitlements.recordUsage).toHaveBeenCalledWith('u1', 'cv_builder_create', {
      sourceType: 'cv',
      sourceId: 'saved-cv',
    });
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

  it('delegates builder section evaluation and rewrite after ownership and entitlement checks', async () => {
    const { service, cvsRepo, evaluator, rewriter, entitlements } = build();
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
    expect(entitlements.assertCanUse).toHaveBeenCalledWith('u1', 'cv_builder_rewrite');
    // userId rides along so the ai_requests trace attributes cost to the real user.
    expect(rewriter.rewrite).toHaveBeenCalledWith(rewriteBody, 'u1');
    expect(entitlements.recordUsage).toHaveBeenCalledWith('u1', 'cv_builder_rewrite', {
      sourceType: 'cv',
      sourceId: 'draft-1',
    });
  });

  it('renders a BUILT CV PDF from parsedJson without storage persistence', async () => {
    const { service, cvsRepo, pdfRenderer, storage, entitlements } = build();
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

    expect(entitlements.assertCanUse).toHaveBeenCalledWith('u1', 'cv_builder_render_pdf');
    expect(pdfRenderer.renderHarvardPdf).toHaveBeenCalledWith(draft);
    expect(entitlements.recordUsage).toHaveBeenCalledWith('u1', 'cv_builder_render_pdf', {
      sourceType: 'cv',
      sourceId: 'draft-1',
    });
    expect(storage.upload).not.toHaveBeenCalled();
    expect(rendered.buffer).toEqual(Buffer.from('%PDF-1.7 rendered'));
  });

  it('analyzes an owned generated PDF when its builder draft has no review for the requested role', async () => {
    const { service, cvsRepo, pdfRenderer, storage, cvReview, analysisQuota, aiResults } = build();
    const ownedCv = {
      id: 'original-cv',
      userId: 'u1',
      title: 'Original',
      originalFileName: null,
      fileType: null,
      fileSize: null,
      parsedText: null,
      parsedJson: {
        ...parsedReview.document,
        summary: 'Built REST APIs with NestJS and PostgreSQL.',
      },
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
    aiResults.manager.query.mockResolvedValue([]);

    const response = await service.create(
      'u1',
      { consentAccepted: true, targetRole: 'fullstack_developer' },
      { ...file, buffer: Buffer.from('%PDF-1.7 generated') },
    );

    expect(response.id).toBe('original-cv');
    expect(response.review).toEqual(parsedReview);
    expect(storage.upload).not.toHaveBeenCalled();
    expect(analysisQuota.assertWithinDailyLimit).toHaveBeenCalledWith('u1');
    expect(analysisQuota.recordSuccessfulAnalysis).toHaveBeenCalledWith('u1', 'original-cv');
    expect(cvReview.review).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({
        cv_id: 'original-cv',
        parsed_text: expect.stringContaining('Built REST APIs with NestJS and PostgreSQL.'),
        target_role: 'fullstack_developer',
      }),
    );
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

  it('blocks upload+scoring when the daily analysis quota is reached — before any storage/row write', async () => {
    const { service, storage, cvsRepo, analysisQuota } = build();
    analysisQuota.assertWithinDailyLimit.mockRejectedValue(
      new HttpException(
        { errorCode: 'CV_ANALYSIS_DAILY_LIMIT_REACHED' },
        HttpStatus.TOO_MANY_REQUESTS,
      ),
    );

    await expect(service.create('u1', { consentAccepted: true }, file)).rejects.toMatchObject({
      response: expect.objectContaining({ errorCode: 'CV_ANALYSIS_DAILY_LIMIT_REACHED' }),
    });
    // enforced AFTER the bypass + upload quota but BEFORE work: nothing stored, no row, no scoring
    expect(storage.upload).not.toHaveBeenCalled();
    expect(cvsRepo.create).not.toHaveBeenCalled();
  });

  it('reuses a role-matched review for an owned generated PDF without consuming analysis quota', async () => {
    const { service, cvsRepo, pdfRenderer, analysisQuota, cvReview, aiResults, storage } = build();
    pdfRenderer.extractSkillbridgeFingerprint.mockResolvedValue('original-cv');
    cvsRepo.findOne.mockResolvedValue({
      id: 'original-cv',
      userId: 'u1',
      cvKind: 'BUILT',
      parsedJson: parsedReview.document,
      targetRole: 'fullstack_developer',
      createdAt: now,
      updatedAt: now,
    });
    aiResults.manager.query.mockResolvedValue([{ parsed_response: parsedReview }]);

    const response = await service.create(
      'u1',
      { consentAccepted: true, targetRole: 'fullstack_developer' },
      {
        ...file,
        buffer: Buffer.from('%PDF-1.7 generated'),
      },
    );

    expect(response.review).toEqual(parsedReview);
    expect(analysisQuota.assertWithinDailyLimit).not.toHaveBeenCalled();
    expect(cvReview.review).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
    const [, params] = aiResults.manager.query.mock.calls.at(-1) as [string, unknown[]];
    expect(params).toContain('fullstack_developer');
  });

  it('re-grades an owned generated PDF when the requested role has no matching review', async () => {
    const { service, cvsRepo, pdfRenderer, analysisQuota, cvReview, aiResults, storage } = build();
    pdfRenderer.extractSkillbridgeFingerprint.mockResolvedValue('original-cv');
    cvsRepo.findOne.mockResolvedValue({
      id: 'original-cv',
      userId: 'u1',
      cvKind: 'BUILT',
      parsedText: null,
      parsedJson: {
        ...parsedReview.document,
        summary: 'Built REST APIs with NestJS and PostgreSQL.',
      },
      targetRole: 'backend_developer',
      createdAt: now,
      updatedAt: now,
    });
    aiResults.manager.query.mockResolvedValue([]);

    await service.create(
      'u1',
      { consentAccepted: true, targetRole: 'data_analyst' },
      { ...file, buffer: Buffer.from('%PDF-1.7 generated') },
    );

    expect(analysisQuota.assertWithinDailyLimit).toHaveBeenCalledWith('u1');
    expect(cvReview.review).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ target_role: 'data_analyst' }),
    );
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('treats a generated PDF with an unowned fingerprint as a normal upload', async () => {
    const { service, cvsRepo, pdfRenderer, storage, extractor, cvReview } = build();
    pdfRenderer.extractSkillbridgeFingerprint.mockResolvedValue('foreign-cv');
    cvsRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

    const response = await service.create(
      'u1',
      { consentAccepted: true, targetRole: 'fullstack_developer' },
      { ...file, buffer: Buffer.from('%PDF-1.7 foreign-generated') },
    );

    expect(response.review).toEqual(parsedReview);
    expect(storage.upload).toHaveBeenCalled();
    expect(extractor.extract).toHaveBeenCalled();
    expect(cvReview.review).toHaveBeenCalled();
  });

  it('does NOT consume the analysis quota for duplicate file content owned by the user', async () => {
    const { service, cvsRepo, storage, cvReview, analysisQuota, aiResults } = build();
    cvsRepo.findOne.mockResolvedValue({
      id: 'existing-cv',
      userId: 'u1',
      title: 'Existing',
      originalFileName: 'sample.pdf',
      fileType: 'application/pdf',
      fileSize: 1024,
      parsedText: 'parsed cv text',
      parsedJson: parsedReview.document,
      cvKind: 'UPLOADED',
      language: 'vi',
      isOcrOnly: false,
      atsReadabilityScore: '80.00',
      targetRole: 'frontend_developer',
      contentHash: 'existing-hash',
      createdAt: now,
      updatedAt: now,
    });
    // Same file, no NEW role requested → an existing analysis is reused (fast, no re-grade).
    aiResults.manager.query.mockResolvedValue([{ parsed_response: parsedReview }]);

    const response = await service.create('u1', { consentAccepted: true }, file);

    expect(response.id).toBe('existing-cv');
    expect(storage.upload).not.toHaveBeenCalled();
    expect(cvReview.review).not.toHaveBeenCalled();
    expect(analysisQuota.assertWithinDailyLimit).not.toHaveBeenCalled();
  });

  it('re-grades a duplicate file when re-uploaded under a NEW target role (role-aware dedup)', async () => {
    const { service, cvsRepo, cvReview, analysisQuota, aiResults } = build();
    cvsRepo.findOne.mockResolvedValue({
      id: 'existing-cv',
      userId: 'u1',
      originalFileName: 'sample.pdf',
      fileType: 'application/pdf',
      fileSize: 1024,
      parsedText: 'parsed cv text',
      parsedJson: parsedReview.document,
      cvKind: 'UPLOADED',
      isOcrOnly: false,
      targetRole: 'backend_developer',
      contentHash: 'existing-hash',
      createdAt: now,
      updatedAt: now,
    });
    // No persisted review exists for the NEWLY requested role → must re-grade against its rubric.
    aiResults.manager.query.mockResolvedValue([]);

    await service.create('u1', { consentAccepted: true, targetRole: 'data_analyst' }, file);

    expect(analysisQuota.assertWithinDailyLimit).toHaveBeenCalled();
    expect(cvReview.review).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ target_role: 'data_analyst' }),
    );
  });

  it('rerunReview re-grades when called with a NEW role (not the stored one) and no cached review for it', async () => {
    const { service, cvsRepo, cvReview, aiResults } = build();
    cvsRepo.findOne.mockResolvedValue({
      id: 'cv-1',
      userId: 'u1',
      parsedText: 'parsed cv text',
      parsedJson: parsedReview.document,
      cvKind: 'UPLOADED',
      fileType: 'application/pdf',
      isOcrOnly: false,
      targetRole: 'backend_developer',
      createdAt: now,
      updatedAt: now,
    });
    aiResults.manager.query.mockResolvedValue([]); // no data_analyst review yet

    await service.rerunReview('u1', 'cv-1', 'data_analyst');

    expect(cvReview.review).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ target_role: 'data_analyst' }),
    );
  });

  it('returns a matching persisted review without consuming analysis quota or calling the model', async () => {
    const { service, cvsRepo, cvReview, analysisQuota, aiResults } = build();
    cvsRepo.findOne.mockResolvedValue({
      id: 'cv-1',
      userId: 'u1',
      parsedText: 'parsed cv text',
      parsedJson: parsedReview.document,
      cvKind: 'UPLOADED',
      fileType: 'application/pdf',
      isOcrOnly: false,
      targetRole: 'backend_developer',
      createdAt: now,
      updatedAt: now,
    });
    aiResults.manager.query.mockResolvedValue([{ parsed_response: parsedReview }]);

    const response = await service.rerunReview('u1', 'cv-1');

    expect(response.review).toEqual(parsedReview);
    expect(analysisQuota.assertWithinDailyLimit).not.toHaveBeenCalled();
    expect(cvReview.review).not.toHaveBeenCalled();
  });

  it('matches the review cache on the NESTED payload prompt code that tracing actually stores', async () => {
    // Regression guard: tracing stores top-level prompt_template_code='cv_review' (loader strips
    // the _v1 into the version) but the constant is 'cv_review_v1'. The lookup MUST filter the
    // nested payload.prompt_template_code (='cv_review_v1') or it returns 0 rows forever and the
    // role-aware cache silently never hits — re-grading + re-charging every scan.
    const { service, cvsRepo, aiResults } = build();
    cvsRepo.findOne.mockResolvedValue({
      id: 'cv-1',
      userId: 'u1',
      parsedText: 'parsed cv text',
      parsedJson: parsedReview.document,
      cvKind: 'UPLOADED',
      fileType: 'application/pdf',
      isOcrOnly: false,
      targetRole: 'backend_developer',
      createdAt: now,
      updatedAt: now,
    });
    aiResults.manager.query.mockResolvedValue([{ parsed_response: parsedReview }]);

    await service.rerunReview('u1', 'cv-1');

    const [sql, params] = aiResults.manager.query.mock.calls.at(-1) as [string, unknown[]];
    expect(sql).toContain("'payload' ->> 'prompt_template_code'");
    expect(sql).not.toContain('prompt_template_version'); // redundant — code encodes the version
    expect(params).toContain('cv_review_v1'); // the value BE actually persists nested
  });

  it('analyzes a BUILT CV by rendering parsedJson to plain text when parsedText is missing', async () => {
    const { service, cvsRepo, cvReview } = build();
    const builtDocument = {
      ...parsedReview.document,
      summary: 'Built REST APIs with NestJS and PostgreSQL.',
    };
    cvsRepo.findOne.mockResolvedValue({
      id: 'draft-1',
      userId: 'u1',
      parsedText: null,
      parsedJson: builtDocument,
      cvKind: 'BUILT',
      fileType: null,
      isOcrOnly: false,
      targetRole: 'backend_developer',
      createdAt: now,
      updatedAt: now,
    });

    await service.rerunReview('u1', 'draft-1');

    expect(cvReview.review).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({
        cv_id: 'draft-1',
        parsed_text: expect.stringContaining('Built REST APIs'),
        target_role: 'backend_developer',
      }),
    );
  });

  it('generates an interview plan from the latest review and records interview quota', async () => {
    const { service, cvsRepo, aiResults, entitlements, interviewPlan } = build();
    cvsRepo.findOne.mockResolvedValue({
      id: 'cv-1',
      userId: 'u1',
      parsedText: 'parsed cv text',
      cvKind: 'UPLOADED',
      createdAt: now,
      updatedAt: now,
    });
    aiResults.manager.query.mockResolvedValue([{ parsed_response: parsedReview }]);

    const response = await service.getInterviewPlan('u1', 'cv-1', 'frontend_developer', 'en');

    expect(entitlements.assertCanUse).toHaveBeenCalledWith('u1', 'interview_session');
    expect(interviewPlan.generatePlan).toHaveBeenCalledWith('u1', {
      review: parsedReview,
      target_role: 'frontend_developer',
      lang: 'en',
    });
    expect(entitlements.recordUsage).toHaveBeenCalledWith('u1', 'interview_session', {
      sourceType: 'cv',
      sourceId: 'cv-1',
    });
    expect(response.target_role).toBe('frontend_developer');
  });

  it('returns 404 for interview plan when the CV has no persisted review', async () => {
    const { service, cvsRepo, aiResults, entitlements, interviewPlan } = build();
    cvsRepo.findOne.mockResolvedValue({
      id: 'cv-1',
      userId: 'u1',
      cvKind: 'UPLOADED',
      createdAt: now,
      updatedAt: now,
    });
    aiResults.manager.query.mockResolvedValue([]);

    await expect(
      service.getInterviewPlan('u1', 'cv-1', 'frontend_developer', 'vi'),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(entitlements.assertCanUse).not.toHaveBeenCalledWith('u1', 'interview_session');
    expect(interviewPlan.generatePlan).not.toHaveBeenCalled();
  });

  it('builds GitHub evidence for an owned CV with the latest review when available', async () => {
    const { service, cvsRepo, aiResults, githubEvidence } = build();
    cvsRepo.findOne.mockResolvedValue({
      id: 'cv-1',
      userId: 'u1',
      cvKind: 'UPLOADED',
      createdAt: now,
      updatedAt: now,
    });
    aiResults.manager.query.mockResolvedValue([{ parsed_response: parsedReview }]);
    githubEvidence.build.mockResolvedValue({ available: true, username: 'octo' });

    const response = await service.getGithubEvidence('u1', 'cv-1', 'octo', true, 'vi');

    expect(githubEvidence.build).toHaveBeenCalledWith({
      username: 'octo',
      consent: true,
      review: parsedReview,
      lang: 'vi',
    });
    expect(response).toEqual({ available: true, username: 'octo' });
  });

  it('enforces the analysis quota on re-run diagnosis (shared budget) before calling the model', async () => {
    const { service, cvsRepo, cvReview, analysisQuota } = build();
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
    analysisQuota.assertWithinDailyLimit.mockRejectedValue(
      new HttpException(
        { errorCode: 'CV_ANALYSIS_DAILY_LIMIT_REACHED' },
        HttpStatus.TOO_MANY_REQUESTS,
      ),
    );

    await expect(service.rerunReview('u1', 'cv-1')).rejects.toMatchObject({
      response: expect.objectContaining({ errorCode: 'CV_ANALYSIS_DAILY_LIMIT_REACHED' }),
    });
    expect(cvReview.review).not.toHaveBeenCalled();
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

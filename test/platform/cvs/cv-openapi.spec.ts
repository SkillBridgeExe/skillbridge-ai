import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { getMetadataArgsStorage } from 'typeorm';
import { CvConsentAuditEntity } from '../../../src/database/entities/cv-consent-audit.entity';
import { IS_PUBLIC_KEY } from '../../../src/platform/auth/decorators/public.decorator';
import { CvsController } from '../../../src/platform/cvs/cvs.controller';
import { DiagnosisController } from '../../../src/platform/cvs/diagnosis.controller';
import { CvsService } from '../../../src/platform/cvs/cvs.service';
import { CvAnalysisQuotaGuard } from '../../../src/platform/cvs/guards/cv-analysis-quota.guard';

describe('CV OpenAPI docs', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [CvsController, DiagnosisController],
      providers: [
        {
          provide: CvsService,
          useValue: {
            create: jest.fn(),
            list: jest.fn(),
            get: jest.fn(),
            download: jest.fn(),
            remove: jest.fn(),
            rerunReview: jest.fn(),
            createBuilderDraft: jest.fn(),
            updateBuilderDraft: jest.fn(),
            evaluateBuilderSection: jest.fn(),
            rewriteBuilderText: jest.fn(),
            renderPdf: jest.fn(),
          },
        },
      ],
    })
      // This suite only builds the Swagger doc; the quota guard's runtime DI is irrelevant here.
      .overrideGuard(CvAnalysisQuotaGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('documents public CV diagnosis request bodies and upload form fields', () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('test').addBearerAuth().build(),
    );

    expect(document.components?.schemas?.PlatformCvReviewRequestDto).toEqual(
      expect.objectContaining({
        required: ['cvId'],
        properties: expect.objectContaining({
          cvId: expect.objectContaining({
            type: 'string',
            format: 'uuid',
            description: expect.any(String),
          }),
        }),
      }),
    );

    const diagnosisRequestBody = document.paths['/api/diagnosis/cv-review']?.post?.requestBody;
    expect(JSON.stringify(diagnosisRequestBody)).toContain('PlatformCvReviewRequestDto');

    const uploadRequestBody = document.paths['/api/cvs']?.post?.requestBody as
      | {
          content?: Record<string, { schema?: unknown }>;
        }
      | undefined;
    const uploadSchema = uploadRequestBody?.content?.['multipart/form-data']?.schema;
    expect(uploadSchema).toEqual(
      expect.objectContaining({
        required: ['file', 'consentAccepted'],
        properties: expect.objectContaining({
          file: expect.objectContaining({ format: 'binary', description: expect.any(String) }),
          targetRole: expect.objectContaining({ description: expect.any(String) }),
          consentAccepted: expect.objectContaining({ description: expect.any(String) }),
        }),
      }),
    );
  });

  it('marks CV endpoints public to bypass internal auth while keeping bearer docs', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, CvsController)).toBe(true);
  });

  it('documents user-facing CV builder endpoints', () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('test').addBearerAuth().build(),
    );

    expect(document.paths['/api/cvs/builder']?.post).toBeDefined();
    expect(document.paths['/api/cvs/{id}/builder']?.put).toBeDefined();
    expect(document.paths['/api/cvs/{id}/builder/evaluate']?.post).toBeDefined();
    expect(document.paths['/api/cvs/{id}/builder/rewrite']?.post).toBeDefined();
    expect(document.paths['/api/cvs/{id}/render-pdf']?.post).toBeDefined();
  });

  it('documents builder request fields, examples, and binary PDF response for Scalar', () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('test').addBearerAuth().build(),
    );

    expect(document.components?.schemas?.CreateBuilderCvDto).toEqual(
      expect.objectContaining({
        properties: expect.objectContaining({
          sourceCvId: expect.objectContaining({
            description: expect.stringContaining('Optional owned CV ID'),
          }),
          title: expect.objectContaining({ description: expect.any(String) }),
          targetRole: expect.objectContaining({
            description: expect.stringContaining('frontend_developer'),
          }),
          language: expect.objectContaining({ enum: ['vi', 'en'] }),
        }),
      }),
    );

    expect(document.components?.schemas?.UpdateBuilderCvDto).toEqual(
      expect.objectContaining({
        required: ['parsedJson'],
        properties: expect.objectContaining({
          parsedJson: expect.objectContaining({
            description: expect.stringContaining('Canonical CV document'),
            example: expect.objectContaining({
              contact: expect.objectContaining({ email: 'a@example.com' }),
              skills: expect.objectContaining({ technical: expect.arrayContaining(['React']) }),
            }),
          }),
        }),
      }),
    );

    expect(document.components?.schemas?.EvaluateSectionRequestDto).toEqual(
      expect.objectContaining({
        required: ['section', 'content'],
        properties: expect.objectContaining({
          section: expect.objectContaining({
            enum: expect.arrayContaining(['basic', 'experience', 'skills']),
            description: expect.stringContaining('Required builder section'),
          }),
          role_code: expect.objectContaining({ description: expect.stringContaining('Optional') }),
          language: expect.objectContaining({ enum: ['vi', 'en'] }),
          content: expect.objectContaining({ description: expect.stringContaining('Required') }),
        }),
      }),
    );

    expect(document.components?.schemas?.RewriteRequestDto).toEqual(
      expect.objectContaining({
        required: ['text', 'mode'],
        properties: expect.objectContaining({
          text: expect.objectContaining({ description: expect.stringContaining('Required') }),
          mode: expect.objectContaining({ enum: ['harvard', 'translate', 'custom'] }),
          target_lang: expect.objectContaining({
            description: expect.stringContaining('mode=translate'),
          }),
          instruction: expect.objectContaining({
            description: expect.stringContaining('mode=custom'),
          }),
        }),
      }),
    );

    const evaluateJson = JSON.stringify(
      document.paths['/api/cvs/{id}/builder/evaluate']?.post?.requestBody,
    );
    expect(evaluateJson).toContain('Evaluate experience');
    expect(evaluateJson).toContain('technicalSkills');
    expect(evaluateJson).not.toContain('Evaluate summary');

    const rewriteJson = JSON.stringify(
      document.paths['/api/cvs/{id}/builder/rewrite']?.post?.requestBody,
    );
    expect(rewriteJson).toContain('Improve wording to Harvard CV style');
    expect(rewriteJson).toContain('Custom rewrite instruction');

    const renderPdfResponse = document.paths['/api/cvs/{id}/render-pdf']?.post?.responses?.['200'];
    expect(JSON.stringify(renderPdfResponse)).toContain('application/pdf');
    expect(JSON.stringify(renderPdfResponse)).toContain('binary');
  });

  it('keeps consent audit indexes aligned with migration intent', () => {
    const indices = getMetadataArgsStorage().indices.filter(
      (index) => index.target === CvConsentAuditEntity,
    );
    const hasColumns = (columns: string[]) =>
      indices.some((index) => JSON.stringify(index.columns) === JSON.stringify(columns));

    expect(hasColumns(['userId', 'cvId'])).toBe(true);
    expect(hasColumns(['createdAt'])).toBe(true);
    expect(hasColumns(['userId'])).toBe(false);
  });
});

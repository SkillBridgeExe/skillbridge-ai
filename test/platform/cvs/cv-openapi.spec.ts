import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { getMetadataArgsStorage } from 'typeorm';
import { CvConsentAuditEntity } from '../../../src/database/entities/cv-consent-audit.entity';
import { IS_PUBLIC_KEY } from '../../../src/platform/auth/decorators/public.decorator';
import { CvsController } from '../../../src/platform/cvs/cvs.controller';
import { DiagnosisController } from '../../../src/platform/cvs/diagnosis.controller';
import { CvsService } from '../../../src/platform/cvs/cvs.service';

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
          },
        },
      ],
    }).compile();

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

  it('does not mark CV endpoints as public', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, CvsController)).toBeUndefined();
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

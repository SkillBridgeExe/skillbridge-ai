import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
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
});

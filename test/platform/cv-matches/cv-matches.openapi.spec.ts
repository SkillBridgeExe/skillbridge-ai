import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { getMetadataArgsStorage } from 'typeorm';
import { CvMatchEntity } from '../../../src/database/entities/cv-match.entity';
import { CvMatchScoreEntity } from '../../../src/database/entities/cv-match-score.entity';
import { JobDescriptionEntity } from '../../../src/database/entities/job-description.entity';
import { IS_PUBLIC_KEY } from '../../../src/platform/auth/decorators/public.decorator';
import {
  CvMatchReportsController,
  CvMatchesController,
} from '../../../src/platform/cv-matches/cv-matches.controller';
import { CvMatchesService } from '../../../src/platform/cv-matches/cv-matches.service';

describe('CV match OpenAPI docs', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [CvMatchesController, CvMatchReportsController],
      providers: [
        {
          provide: CvMatchesService,
          useValue: {
            createMatch: jest.fn(),
            listMatches: jest.fn(),
            getMatch: jest.fn(),
            getGapReport: jest.fn(),
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

  it('documents the CV route shape for match creation and history', () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('test').addBearerAuth().build(),
    );

    expect(document.paths['/api/cvs/{cvId}/match']?.post).toBeDefined();
    expect(document.paths['/api/cvs/{cvId}/match/file']?.post).toBeDefined();
    expect(document.paths['/api/cvs/{cvId}/matches']?.get).toBeDefined();
    expect(document.paths['/api/cvs/{cvId}/matches/{matchId}']?.get).toBeDefined();
    expect(document.paths['/api/cv-matches/{matchId}/gap-report']?.get).toBeDefined();

    const requestBody = document.paths['/api/cvs/{cvId}/match']?.post?.requestBody;
    const content = requestBody && 'content' in requestBody ? requestBody.content : undefined;
    expect(content?.['application/json']?.schema).toEqual(
      expect.objectContaining({
        required: ['jdText'],
        properties: expect.objectContaining({
          jdText: expect.objectContaining({ type: 'string' }),
          title: expect.objectContaining({ type: 'string' }),
          targetRole: expect.objectContaining({ type: 'string' }),
          targetBand: expect.objectContaining({ enum: ['intern', 'fresher', 'mid'] }),
        }),
      }),
    );

    const fileRequestBody = document.paths['/api/cvs/{cvId}/match/file']?.post?.requestBody;
    const fileContent =
      fileRequestBody && 'content' in fileRequestBody ? fileRequestBody.content : undefined;
    expect(fileContent?.['multipart/form-data']?.schema).toEqual(
      expect.objectContaining({
        required: ['file'],
        properties: expect.objectContaining({
          file: expect.objectContaining({ type: 'string', format: 'binary' }),
          title: expect.objectContaining({ type: 'string' }),
          targetRole: expect.objectContaining({ type: 'string' }),
          targetBand: expect.objectContaining({ enum: ['intern', 'fresher', 'mid'] }),
        }),
      }),
    );
  });

  it('marks CV match endpoints public to bypass internal auth while keeping bearer docs', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, CvMatchesController)).toBe(true);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, CvMatchReportsController)).toBe(true);
  });

  it('keeps JD match persistence indexes aligned with migration intent', () => {
    const indices = getMetadataArgsStorage().indices;
    const hasIndex = (target: unknown, column: string) =>
      indices.some(
        (index) =>
          index.target === target && Array.isArray(index.columns) && index.columns.includes(column),
      );

    expect(hasIndex(JobDescriptionEntity, 'userId')).toBe(true);
    expect(hasIndex(JobDescriptionEntity, 'sourceType')).toBe(true);
    expect(hasIndex(CvMatchEntity, 'cvId')).toBe(true);
    expect(hasIndex(CvMatchEntity, 'jobDescriptionId')).toBe(true);
    expect(hasIndex(CvMatchScoreEntity, 'matchId')).toBe(true);
    expect(hasIndex(CvMatchScoreEntity, 'criteriaName')).toBe(true);
  });
});

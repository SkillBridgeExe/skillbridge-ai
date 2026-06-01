import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { setupOpenApi } from '../src/openapi';
import { ConfigService } from '@nestjs/config';

describe('SkillBridge AI (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useGlobalFilters(new AllExceptionsFilter());
    await setupOpenApi(app, app.get(ConfigService));
    await app.init();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('GET /health returns ok without auth and matches shared envelope', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        success: true,
        message: null,
        errors: null,
        data: expect.objectContaining({ status: 'ok' }),
      }),
    );
  });

  it('POST /internal/ai/cv-review without X-Internal-Auth returns 401 with shared error envelope', async () => {
    const res = await request(app.getHttpServer())
      .post('/internal/ai/cv-review')
      .send({})
      .expect(401);
    expect(res.body).toEqual(
      expect.objectContaining({
        success: false,
        data: null,
        errorCode: 'UNAUTHORIZED',
      }),
    );
    expect(typeof res.body.message).toBe('string');
    // errors is null for non-validation failures
    expect(res.body.errors).toBeNull();
  });

  it('GET /openapi.json exposes the OpenAPI document for frontend tooling', async () => {
    const res = await request(app.getHttpServer()).get('/openapi.json').expect(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        openapi: expect.any(String),
        paths: expect.objectContaining({
          '/health': expect.any(Object),
        }),
      }),
    );
  });

  it('GET /reference serves Scalar API Reference', async () => {
    const res = await request(app.getHttpServer()).get('/reference').expect(200);
    expect(res.text).toContain('Scalar');
  });
});

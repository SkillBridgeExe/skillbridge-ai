import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';

describe('SkillBridge AI (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.INTERNAL_AUTH_SECRET = 'test-secret-at-least-16-chars';
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health returns ok without auth', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('ok');
  });

  it('POST /internal/ai/cv-review without X-Internal-Auth returns 401', async () => {
    const res = await request(app.getHttpServer())
      .post('/internal/ai/cv-review')
      .send({})
      .expect(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

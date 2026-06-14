import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { CorrelationIdInterceptor } from './common/interceptors/correlation-id.interceptor';
import { setupOpenApi } from './openapi';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';

const DEFAULT_CORS_ORIGINS = [
  'http://localhost:8080',
  'http://localhost:5173',
  'http://localhost:4173',
  'http://127.0.0.1:8080',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:4173',
  'https://www.skillbridgebuilder.com',
  'https://skillbridgebuilder.com',
  'https://skillbridge-fe-973344038436.asia-southeast1.run.app',
  'https://skillbridge-fe-pkbqs32y4q-as.a.run.app',
];

function parseCsvEnv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'error', 'warn', 'debug', 'verbose'],
  });

  const config = app.get(ConfigService);
  const port = config.get<number>('PORT', 3002);
  const nodeEnv = config.get<string>('NODE_ENV', 'development');
  const apiDocsEnabled = config.get<boolean>('API_DOCS_ENABLED') ?? true;

  // Security headers + CORS (NestJS is now public-facing — see ARCHITECTURE.md §6)
  app.use(
    helmet({
      contentSecurityPolicy: nodeEnv === 'production' && !apiDocsEnabled ? undefined : false,
    }),
  );
  app.use(cookieParser());
  const corsOrigins = Array.from(
    new Set([...DEFAULT_CORS_ORIGINS, ...parseCsvEnv(config.get<string>('CORS_ORIGINS'))]),
  );
  app.enableCors({ origin: corsOrigins, credentials: true });

  // Global validation: strip unknown fields, fail on missing required fields
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Global response envelope (shared with .NET):
  //   success: { success: true, message, data, errors: null }
  //   error:   { success: false, message, data: null, errors, errorCode }
  app.useGlobalInterceptors(new CorrelationIdInterceptor(), new ResponseInterceptor());
  app.useGlobalFilters(new AllExceptionsFilter());
  await setupOpenApi(app, config);

  await app.listen(port, '0.0.0.0');

  const logger = new Logger('Bootstrap');
  logger.log(`SkillBridge AI Service listening on port ${port} (${nodeEnv})`);
}

bootstrap();

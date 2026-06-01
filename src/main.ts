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

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'error', 'warn', 'debug', 'verbose'],
  });

  const config = app.get(ConfigService);
  const port = config.get<number>('PORT', 3002);
  const nodeEnv = config.get<string>('NODE_ENV', 'development');

  // Security headers + CORS (NestJS is now public-facing — see ARCHITECTURE.md §6)
  app.use(helmet({ contentSecurityPolicy: nodeEnv === 'production' ? undefined : false }));
  app.use(cookieParser());
  const corsOrigins = (config.get<string>('CORS_ORIGINS') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  app.enableCors({ origin: corsOrigins.length > 0 ? corsOrigins : true, credentials: true });

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

  await app.listen(port);

  const logger = new Logger('Bootstrap');
  logger.log(`SkillBridge AI Service listening on port ${port} (${nodeEnv})`);
}

bootstrap();

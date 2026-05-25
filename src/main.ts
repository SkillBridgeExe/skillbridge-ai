import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { CorrelationIdInterceptor } from './common/interceptors/correlation-id.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'error', 'warn', 'debug', 'verbose'],
  });

  const config = app.get(ConfigService);
  const port = config.get<number>('PORT', 3002);
  const nodeEnv = config.get<string>('NODE_ENV', 'development');

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

  await app.listen(port);

  const logger = new Logger('Bootstrap');
  logger.log(`SkillBridge AI Service listening on port ${port} (${nodeEnv})`);
}

bootstrap();

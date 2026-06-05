import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';

import { DatabaseOrmModule } from './database/database-orm.module';
import { AuthModule } from './platform/auth/auth.module';
import { CvsModule } from './platform/cvs/cvs.module';
import { UsersModule } from './platform/users/users.module';

import configuration from './config/configuration';
import { configValidationSchema } from './config/validation';

import { InternalAuthGuard } from './common/guards/internal-auth.guard';

import { DatabaseModule } from './infrastructure/database/database.module';
import { VectorModule } from './infrastructure/vector/vector.module';
import { LlmModule } from './infrastructure/llm/llm.module';

import { CommonServicesModule } from './common/services/common-services.module';

import { HealthModule } from './modules/health/health.module';
import { PromptsModule } from './modules/prompts/prompts.module';
import { TracingModule } from './modules/tracing/tracing.module';
import { EmbeddingsModule } from './modules/embeddings/embeddings.module';
import { RagModule } from './modules/rag/rag.module';
import { CvReviewModule } from './modules/cv-review/cv-review.module';
import { CvJdMatchModule } from './modules/cv-jd-match/cv-jd-match.module';
import { InterviewModule } from './modules/interview/interview.module';
import { RoadmapModule } from './modules/roadmap/roadmap.module';
import { JobsModule } from './modules/jobs/jobs.module';

// Platform modules need the DB → skip in the e2e env (NODE_ENV=test, no Postgres).
const PLATFORM_MODULES =
  process.env.NODE_ENV === 'test' ? [] : [AuthModule, UsersModule, CvsModule];

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema: configValidationSchema,
      validationOptions: { abortEarly: false },
    }),

    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => [
        {
          ttl: (config.get<number>('THROTTLE_TTL') ?? 60) * 1000,
          limit: config.get<number>('THROTTLE_LIMIT') ?? 100,
        },
      ],
    }),

    // Database (TypeORM) — connects only outside NODE_ENV=test
    DatabaseOrmModule.forRoot(),

    // Infrastructure (cross-cutting)
    DatabaseModule,
    VectorModule,
    LlmModule,

    // Cross-cutting common services (skill taxonomy + normalization + rubrics)
    // @Global so feature modules don't need to import explicitly.
    CommonServicesModule,

    // Internal services
    PromptsModule,
    TracingModule,

    // Feature modules (one per /internal/ai/* endpoint family)
    HealthModule,
    EmbeddingsModule,
    RagModule,
    CvReviewModule,
    CvJdMatchModule,
    InterviewModule,
    RoadmapModule,
    JobsModule,

    // Platform context (auth/users) — loaded only outside test (needs DB)
    ...PLATFORM_MODULES,
  ],
  providers: [
    // Rate limiting (public-facing) — runs before the auth guards.
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    // Global guard: every /internal/ai/* route requires X-Internal-Auth.
    // Public routes (e.g. /health, /api/auth/*) opt out via @Public() decorator.
    {
      provide: APP_GUARD,
      useClass: InternalAuthGuard,
    },
  ],
})
export class AppModule {}

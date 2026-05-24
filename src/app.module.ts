import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';

import configuration from './config/configuration';
import { configValidationSchema } from './config/validation';

import { InternalAuthGuard } from './common/guards/internal-auth.guard';

import { DatabaseModule } from './infrastructure/database/database.module';
import { VectorModule } from './infrastructure/vector/vector.module';
import { LlmModule } from './infrastructure/llm/llm.module';

import { HealthModule } from './modules/health/health.module';
import { PromptsModule } from './modules/prompts/prompts.module';
import { TracingModule } from './modules/tracing/tracing.module';
import { EmbeddingsModule } from './modules/embeddings/embeddings.module';
import { RagModule } from './modules/rag/rag.module';
import { CvReviewModule } from './modules/cv-review/cv-review.module';
import { CvJdMatchModule } from './modules/cv-jd-match/cv-jd-match.module';
import { InterviewModule } from './modules/interview/interview.module';
import { RoadmapModule } from './modules/roadmap/roadmap.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema: configValidationSchema,
      validationOptions: { abortEarly: false },
    }),

    // Infrastructure (cross-cutting)
    DatabaseModule,
    VectorModule,
    LlmModule,

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
  ],
  providers: [
    // Global guard: every /internal/ai/* route requires X-Internal-Auth.
    // Public routes (e.g. /health) opt out via @Public() decorator.
    {
      provide: APP_GUARD,
      useClass: InternalAuthGuard,
    },
  ],
})
export class AppModule {}

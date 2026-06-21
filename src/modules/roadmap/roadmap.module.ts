import { Module } from '@nestjs/common';
import { RoadmapController } from './roadmap.controller';
import { RoadmapService } from './roadmap.service';
import { CourseMatcherService } from './course-matcher.service';
import { LearningResourceMatcherService } from './learning-resource-matcher.service';
import { LearningResourceRetriever } from './learning-resource-retriever.service';
import { RagModule } from '../rag/rag.module';

@Module({
  imports: [RagModule],
  controllers: [RoadmapController],
  providers: [
    RoadmapService,
    CourseMatcherService,
    LearningResourceMatcherService,
    LearningResourceRetriever,
  ],
  // LearningResourceRetriever is exported so the RAG-PR2 learning-chat module can consume it.
  exports: [RoadmapService, LearningResourceRetriever],
})
export class RoadmapModule {}

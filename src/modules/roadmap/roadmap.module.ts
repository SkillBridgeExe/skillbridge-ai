import { Module } from '@nestjs/common';
import { RoadmapController } from './roadmap.controller';
import { RoadmapService } from './roadmap.service';
import { CourseMatcherService } from './course-matcher.service';
import { RagModule } from '../rag/rag.module';
import { LearningResourceMatcherService } from './learning-resource-matcher.service';

@Module({
  imports: [RagModule],
  controllers: [RoadmapController],
  providers: [RoadmapService, CourseMatcherService, LearningResourceMatcherService],
  exports: [RoadmapService],
})
export class RoadmapModule {}

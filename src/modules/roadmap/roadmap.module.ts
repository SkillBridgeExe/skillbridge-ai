import { Module } from '@nestjs/common';
import { RoadmapController } from './roadmap.controller';
import { RoadmapService } from './roadmap.service';
import { CourseMatcherService } from './course-matcher.service';
import { LearningResourceMatcherService } from './learning-resource-matcher.service';
import { RoadmapComposerService } from './roadmap-composer.service';
import { RagModule } from '../rag/rag.module';

@Module({
  imports: [RagModule],
  controllers: [RoadmapController],
  providers: [
    RoadmapService,
    CourseMatcherService,
    LearningResourceMatcherService,
    RoadmapComposerService,
  ],
  exports: [RoadmapService],
})
export class RoadmapModule {}

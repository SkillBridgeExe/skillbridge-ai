import { Module } from '@nestjs/common';
import { RoadmapController } from './roadmap.controller';
import { RoadmapService } from './roadmap.service';
import { CourseMatcherService } from './course-matcher.service';
import { RagModule } from '../rag/rag.module';

@Module({
  imports: [RagModule],
  controllers: [RoadmapController],
  providers: [RoadmapService, CourseMatcherService],
  exports: [RoadmapService],
})
export class RoadmapModule {}

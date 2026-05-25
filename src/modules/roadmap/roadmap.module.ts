import { Module } from '@nestjs/common';
import { RoadmapController } from './roadmap.controller';
import { RoadmapService } from './roadmap.service';
import { RagModule } from '../rag/rag.module';

@Module({
  imports: [RagModule],
  controllers: [RoadmapController],
  providers: [RoadmapService],
})
export class RoadmapModule {}

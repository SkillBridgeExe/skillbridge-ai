import { Module } from '@nestjs/common';
import { CvJdMatchController } from './cv-jd-match.controller';
import { CvJdMatchService } from './cv-jd-match.service';
import { RagModule } from '../rag/rag.module';

@Module({
  imports: [RagModule],
  controllers: [CvJdMatchController],
  providers: [CvJdMatchService],
})
export class CvJdMatchModule {}

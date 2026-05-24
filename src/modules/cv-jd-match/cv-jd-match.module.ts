import { Module } from '@nestjs/common';
import { CvJdMatchController } from './cv-jd-match.controller';
import { CvJdMatchService } from './cv-jd-match.service';

@Module({
  controllers: [CvJdMatchController],
  providers: [CvJdMatchService],
})
export class CvJdMatchModule {}

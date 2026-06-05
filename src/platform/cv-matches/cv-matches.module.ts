import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CvEntity } from '../../database/entities/cv.entity';
import { CvMatchEntity } from '../../database/entities/cv-match.entity';
import { CvMatchScoreEntity } from '../../database/entities/cv-match-score.entity';
import { JobDescriptionEntity } from '../../database/entities/job-description.entity';
import { CvJdMatchModule } from '../../modules/cv-jd-match/cv-jd-match.module';
import { CvMatchesController } from './cv-matches.controller';
import { CvMatchesService } from './cv-matches.service';
import { JdTextExtractorService } from './jd-text-extractor.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([CvEntity, JobDescriptionEntity, CvMatchEntity, CvMatchScoreEntity]),
    CvJdMatchModule,
  ],
  controllers: [CvMatchesController],
  providers: [CvMatchesService, JdTextExtractorService],
})
export class CvMatchesModule {}

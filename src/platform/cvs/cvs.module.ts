import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CvEntity } from '../../database/entities/cv.entity';
import { CvSkillEntity } from '../../database/entities/cv-skill.entity';
import { SkillEntity } from '../../database/entities/skill.entity';
import { StorageModule } from '../../infrastructure/storage/storage.module';
import { CvReviewModule } from '../../modules/cv-review/cv-review.module';
import { CvsController } from './cvs.controller';
import { DiagnosisController } from './diagnosis.controller';
import { CvsService } from './cvs.service';
import { TextExtractorService } from './text-extractor.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([CvEntity, CvSkillEntity, SkillEntity]),
    StorageModule,
    CvReviewModule,
  ],
  controllers: [CvsController, DiagnosisController],
  providers: [CvsService, TextExtractorService],
})
export class CvsModule {}

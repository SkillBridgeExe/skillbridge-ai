import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MentorProfileEntity } from '../../database/entities/mentor-profile.entity';
import { MentorProfileSkillEntity } from '../../database/entities/mentor-profile-skill.entity';
import { SkillEntity } from '../../database/entities/skill.entity';
import { UserEntity } from '../../database/entities/user.entity';
import { RolesGuard } from '../auth/guards/roles.guard';
import {
  AdminMentorsController,
  MentorSelfProfileController,
  MentorsController,
} from './mentors.controller';
import { MentorsService } from './mentors.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      MentorProfileEntity,
      MentorProfileSkillEntity,
      UserEntity,
      SkillEntity,
    ]),
  ],
  controllers: [MentorsController, MentorSelfProfileController, AdminMentorsController],
  providers: [MentorsService, RolesGuard],
  exports: [MentorsService],
})
export class MentorsModule {}

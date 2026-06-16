import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountEntity } from '../../database/entities/account.entity';
import { CvMatchEntity } from '../../database/entities/cv-match.entity';
import { CvEntity } from '../../database/entities/cv.entity';
import { InterviewSessionEntity } from '../../database/entities/interview-session.entity';
import { PaymentOrderEntity } from '../../database/entities/payment-order.entity';
import { RoleEntity } from '../../database/entities/role.entity';
import { SessionEntity } from '../../database/entities/session.entity';
import { SkillEntity } from '../../database/entities/skill.entity';
import { UsageEventEntity } from '../../database/entities/usage-event.entity';
import { UserEntity } from '../../database/entities/user.entity';
import { UserProfileEntity } from '../../database/entities/user-profile.entity';
import { UserRoleEntity } from '../../database/entities/user-role.entity';
import { UserSkillEntity } from '../../database/entities/user-skill.entity';
import { UserSubscriptionEntity } from '../../database/entities/user-subscription.entity';
import { StorageModule } from '../../infrastructure/storage/storage.module';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';
import { SkillsController, UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      UserEntity,
      UserProfileEntity,
      UserSkillEntity,
      SkillEntity,
      RoleEntity,
      UserRoleEntity,
      AccountEntity,
      SessionEntity,
      CvEntity,
      CvMatchEntity,
      InterviewSessionEntity,
      PaymentOrderEntity,
      UserSubscriptionEntity,
      UsageEventEntity,
    ]),
    StorageModule,
  ],
  controllers: [UsersController, SkillsController, AdminUsersController],
  providers: [UsersService, AdminUsersService],
  exports: [UsersService],
})
export class UsersModule {}

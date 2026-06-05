import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RoleEntity } from '../../database/entities/role.entity';
import { SkillEntity } from '../../database/entities/skill.entity';
import { UserEntity } from '../../database/entities/user.entity';
import { UserProfileEntity } from '../../database/entities/user-profile.entity';
import { UserRoleEntity } from '../../database/entities/user-role.entity';
import { UserSkillEntity } from '../../database/entities/user-skill.entity';
import { StorageModule } from '../../infrastructure/storage/storage.module';
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
    ]),
    StorageModule,
  ],
  controllers: [UsersController, SkillsController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}

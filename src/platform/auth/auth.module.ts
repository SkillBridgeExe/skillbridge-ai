import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity } from '../../database/entities/user.entity';
import { AccountEntity } from '../../database/entities/account.entity';
import { SessionEntity } from '../../database/entities/session.entity';
import { RoleEntity } from '../../database/entities/role.entity';
import { UserRoleEntity } from '../../database/entities/user-role.entity';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';

/**
 * Platform context — auth. Conditionally loaded by AppModule (needs the DB).
 * ConfigModule is global, so ConfigService is available without re-importing.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      UserEntity,
      AccountEntity,
      SessionEntity,
      RoleEntity,
      UserRoleEntity,
    ]),
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_ACCESS_SECRET') ?? 'dev-access-secret-change-me',
        signOptions: { expiresIn: config.get<number>('JWT_ACCESS_TTL') ?? 3600 },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
})
export class AuthModule {}

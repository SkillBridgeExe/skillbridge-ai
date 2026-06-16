import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { In, Repository } from 'typeorm';
import { RoleEntity } from '../../../database/entities/role.entity';
import { UserRoleEntity } from '../../../database/entities/user-role.entity';
import { UserEntity } from '../../../database/entities/user.entity';
import { JwtUser } from '../decorators/current-user.decorator';

interface JwtPayload {
  sub: string;
  email: string;
  roles: string[];
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    @InjectRepository(RoleEntity)
    private readonly roles: Repository<RoleEntity>,
    @InjectRepository(UserRoleEntity)
    private readonly userRoles: Repository<UserRoleEntity>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_ACCESS_SECRET') ?? 'dev-access-secret-change-me',
    });
  }

  async validate(payload: JwtPayload): Promise<JwtUser> {
    if (!payload?.sub) throw new UnauthorizedException();
    const user = await this.users.findOne({ where: { id: payload.sub } });
    if (!user || !user.isActive || user.status !== 'ACTIVE') {
      throw new UnauthorizedException();
    }

    const userRoles = await this.userRoles.find({ where: { userId: user.id } });
    const roleIds = [...new Set(userRoles.map((userRole) => userRole.roleId))];
    const roles = roleIds.length
      ? await this.roles.find({ where: { id: In(roleIds) as unknown as string } })
      : [];

    return {
      userId: user.id,
      email: user.email,
      roles: roles.map((role) => role.code),
    };
  }
}

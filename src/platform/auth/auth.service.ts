import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { createHash, randomBytes } from 'crypto';
import * as bcrypt from 'bcrypt';
import { OAuth2Client } from 'google-auth-library';
import { UserEntity } from '../../database/entities/user.entity';
import { AccountEntity } from '../../database/entities/account.entity';
import { SessionEntity } from '../../database/entities/session.entity';
import { RoleEntity, RoleCode } from '../../database/entities/role.entity';
import { UserRoleEntity } from '../../database/entities/user-role.entity';
import { RegisterDto } from './dto/register.dto';

/**
 * Auth (platform context — was the .NET BFF's job). Credentials + Google.
 * Access token = JWT (Bearer). Refresh token = opaque random, hashed in `sessions`,
 * delivered as an HttpOnly cookie; rotated on every refresh.
 */
@Injectable()
export class AuthService {
  private readonly google: OAuth2Client;

  constructor(
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectRepository(AccountEntity) private readonly accounts: Repository<AccountEntity>,
    @InjectRepository(SessionEntity) private readonly sessions: Repository<SessionEntity>,
    @InjectRepository(RoleEntity) private readonly roles: Repository<RoleEntity>,
    @InjectRepository(UserRoleEntity) private readonly userRoles: Repository<UserRoleEntity>,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {
    this.google = new OAuth2Client(this.config.get<string>('GOOGLE_CLIENT_ID'));
  }

  async register(dto: RegisterDto) {
    const emailNormalized = dto.email.trim().toLowerCase();
    if (await this.users.findOne({ where: { emailNormalized } })) {
      throw new ConflictException('Email already registered');
    }
    const user = await this.users.save(
      this.users.create({
        email: dto.email.trim(),
        emailNormalized,
        fullName: dto.displayName,
        status: 'ACTIVE',
        isEmailVerified: false,
        isActive: true,
      }),
    );
    await this.accounts.save(
      this.accounts.create({
        userId: user.id,
        provider: 'CREDENTIALS',
        providerAccountId: emailNormalized,
        passwordHash: await bcrypt.hash(dto.password, 10),
      }),
    );
    await this.assignRole(user.id, 'USER');
    // TODO: send verification email (Resend). Login stays blocked until verified.
    return { user: this.publicUser(user, ['USER']), accessToken: null };
  }

  async login(email: string, password: string) {
    const emailNormalized = email.trim().toLowerCase();
    const user = await this.users.findOne({ where: { emailNormalized } });
    if (!user || !user.isActive) throw new UnauthorizedException('Invalid credentials');
    const account = await this.accounts.findOne({
      where: { userId: user.id, provider: 'CREDENTIALS' },
    });
    if (!account?.passwordHash || !(await bcrypt.compare(password, account.passwordHash))) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return this.issue(user, await this.roleCodes(user.id));
  }

  async googleLogin(idToken: string) {
    const ticket = await this.google.verifyIdToken({
      idToken,
      audience: this.config.get<string>('GOOGLE_CLIENT_ID'),
    });
    const payload = ticket.getPayload();
    if (!payload?.email) throw new UnauthorizedException('Invalid Google token');
    const emailNormalized = payload.email.toLowerCase();
    let user = await this.users.findOne({ where: { emailNormalized } });
    if (!user) {
      user = await this.users.save(
        this.users.create({
          email: payload.email,
          emailNormalized,
          fullName: payload.name ?? null,
          avatarUrl: payload.picture ?? null,
          status: 'ACTIVE',
          isEmailVerified: true,
          isActive: true,
        }),
      );
      await this.accounts.save(
        this.accounts.create({
          userId: user.id,
          provider: 'GOOGLE',
          providerAccountId: payload.sub,
        }),
      );
      await this.assignRole(user.id, 'USER');
    }
    return this.issue(user, await this.roleCodes(user.id));
  }

  async refresh(refreshToken: string | undefined) {
    if (!refreshToken) throw new UnauthorizedException('Refresh token cookie is missing');
    const session = await this.sessions.findOne({
      where: { refreshTokenHash: this.hash(refreshToken) },
    });
    if (!session || session.revokedAt || session.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Refresh token invalid or expired');
    }
    const user = await this.users.findOne({ where: { id: session.userId } });
    if (!user || !user.isActive) throw new UnauthorizedException();
    session.revokedAt = new Date();
    await this.sessions.save(session);
    return this.issue(user, await this.roleCodes(user.id));
  }

  async logout(refreshToken: string | undefined) {
    if (!refreshToken) return;
    await this.sessions.update(
      { refreshTokenHash: this.hash(refreshToken) },
      { revokedAt: new Date() },
    );
  }

  async me(userId: string) {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();
    return this.publicUser(user, await this.roleCodes(userId));
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private async issue(user: UserEntity, roles: string[]) {
    const accessTtl = this.config.get<number>('JWT_ACCESS_TTL') ?? 3600;
    const refreshTtl = this.config.get<number>('JWT_REFRESH_TTL') ?? 604800;
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, email: user.email, roles },
      { secret: this.config.get<string>('JWT_ACCESS_SECRET'), expiresIn: accessTtl },
    );
    const refreshToken = randomBytes(32).toString('hex');
    await this.sessions.save(
      this.sessions.create({
        userId: user.id,
        refreshTokenHash: this.hash(refreshToken),
        expiresAt: new Date(Date.now() + refreshTtl * 1000),
      }),
    );
    return { user: this.publicUser(user, roles), accessToken, expiresIn: accessTtl, refreshToken };
  }

  private async assignRole(userId: string, code: RoleCode): Promise<void> {
    let role = await this.roles.findOne({ where: { code } });
    if (!role) role = await this.roles.save(this.roles.create({ code, name: code }));
    await this.userRoles.save(this.userRoles.create({ userId, roleId: role.id }));
  }

  private async roleCodes(userId: string): Promise<string[]> {
    const links = await this.userRoles.find({ where: { userId } });
    if (links.length === 0) return [];
    const roles = await this.roles.find({ where: { id: In(links.map((l) => l.roleId)) } });
    return roles.map((r) => r.code);
  }

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private publicUser(user: UserEntity, roles: string[]) {
    return {
      id: user.id,
      email: user.email,
      displayName: user.fullName,
      avatarUrl: user.avatarUrl,
      roles,
      isEmailVerified: user.isEmailVerified,
    };
  }
}

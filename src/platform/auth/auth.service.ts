import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { createHash, randomBytes } from 'crypto';
import * as bcrypt from 'bcrypt';
import { OAuth2Client } from 'google-auth-library';
import { UserEntity } from '../../database/entities/user.entity';
import { AccountEntity } from '../../database/entities/account.entity';
import { SessionEntity } from '../../database/entities/session.entity';
import { RoleEntity, RoleCode } from '../../database/entities/role.entity';
import { UserRoleEntity } from '../../database/entities/user-role.entity';
import { VerificationEntity } from '../../database/entities/verification.entity';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { EmailService } from '../../infrastructure/email/email.service';
import { UsersService } from '../users/users.service';
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
    @InjectRepository(VerificationEntity)
    private readonly verifications: Repository<VerificationEntity>,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly email: EmailService,
    private readonly usersService: UsersService,
  ) {
    this.google = new OAuth2Client(this.config.get<string>('GOOGLE_CLIENT_ID'));
  }

  async register(dto: RegisterDto) {
    const emailNormalized = dto.email.trim().toLowerCase();
    if (await this.users.findOne({ where: { emailNormalized } })) {
      throw new ConflictException({
        errorCode: ERROR_CODES.EMAIL_ALREADY_EXISTS,
        message: 'Email already registered',
      });
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
    await this.assignRole(user.id, dto.role);
    const token = await this.createVerificationToken(user.id);
    await this.email.sendVerifyEmail(user.email, this.buildVerifyUrl(token));
    return { user: this.publicUser(user, [dto.role]), accessToken: null };
  }

  async verifyEmail(token: string) {
    const verification = await this.verifications.findOne({
      where: { purpose: 'EMAIL_VERIFY', valueHash: this.hash(token) },
    });

    if (!verification || verification.usedAt || verification.expiresAt.getTime() < Date.now()) {
      if (verification) {
        verification.attemptCount += 1;
        await this.verifications.save(verification);
      }
      throw new UnauthorizedException({
        errorCode: ERROR_CODES.UNAUTHORIZED,
        message: 'Verification token invalid or expired',
      });
    }

    const user = await this.users.findOne({ where: { id: verification.userId } });
    if (!user || !user.isActive) {
      throw new UnauthorizedException({
        errorCode: ERROR_CODES.UNAUTHORIZED,
        message: 'Verification token invalid or expired',
      });
    }

    user.isEmailVerified = true;
    verification.usedAt = new Date();
    await this.users.save(user);
    await this.verifications.save(verification);
    return { verified: true };
  }

  async resendVerificationEmail(email: string) {
    const emailNormalized = email.trim().toLowerCase();
    const user = await this.users.findOne({ where: { emailNormalized } });
    if (user?.isActive && !user.isEmailVerified) {
      const token = await this.createVerificationToken(user.id);
      await this.email.sendVerifyEmail(user.email, this.buildVerifyUrl(token));
    }
    return { accepted: true };
  }

  async login(email: string, password: string) {
    const emailNormalized = email.trim().toLowerCase();
    const user = await this.users.findOne({ where: { emailNormalized } });
    if (!user || !user.isActive) throw this.invalidCredentials();
    const account = await this.accounts.findOne({
      where: { userId: user.id, provider: 'CREDENTIALS' },
    });
    if (!account?.passwordHash || !(await bcrypt.compare(password, account.passwordHash))) {
      throw this.invalidCredentials();
    }
    if (!user.isEmailVerified) {
      throw new UnauthorizedException({
        errorCode: ERROR_CODES.EMAIL_NOT_VERIFIED,
        message: 'Please verify your email before logging in',
      });
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
    } else if (!user.isEmailVerified) {
      user.isEmailVerified = true;
      user = await this.users.save(user);
    }

    const existingGoogleAccount = await this.accounts.findOne({
      where: { userId: user.id, provider: 'GOOGLE' },
    });
    if (!existingGoogleAccount) {
      await this.accounts.save(
        this.accounts.create({
          userId: user.id,
          provider: 'GOOGLE',
          providerAccountId: payload.sub,
        }),
      );
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
    return this.usersService.getCurrentUserAggregate(userId);
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

  private async createVerificationToken(userId: string): Promise<string> {
    await this.verifications.update(
      { userId, purpose: 'EMAIL_VERIFY', usedAt: IsNull() },
      { usedAt: new Date() },
    );

    const ttlSeconds = this.config.get<number>('EMAIL_VERIFY_TOKEN_TTL_SECONDS') ?? 86400;
    const token = randomBytes(32).toString('hex');
    await this.verifications.save(
      this.verifications.create({
        userId,
        purpose: 'EMAIL_VERIFY',
        valueHash: this.hash(token),
        expiresAt: new Date(Date.now() + ttlSeconds * 1000),
        usedAt: null,
        attemptCount: 0,
      }),
    );
    return token;
  }

  private buildVerifyUrl(token: string): string {
    const baseUrl = this.config.get<string>('FRONTEND_BASE_URL') ?? 'http://localhost:8080';
    return `${baseUrl.replace(/\/$/, '')}/verify-email?token=${encodeURIComponent(token)}`;
  }

  private invalidCredentials(): UnauthorizedException {
    return new UnauthorizedException({
      errorCode: ERROR_CODES.INVALID_CREDENTIALS,
      message: 'Incorrect email or password',
    });
  }

  private publicUser(user: UserEntity, roles: string[]) {
    return {
      id: user.id,
      email: user.email,
      displayName: user.fullName,
      avatarUrl: this.toPublicAvatarUrl(user.avatarUrl),
      roles,
      isEmailVerified: user.isEmailVerified,
    };
  }

  private toPublicAvatarUrl(avatarUrl: string | null): string | null {
    if (!avatarUrl) return null;
    return avatarUrl.startsWith('avatars/') ? '/api/users/me/avatar' : avatarUrl;
  }
}

import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { Repository } from 'typeorm';
import { AuthService } from './auth.service';
import { EmailService } from '../../infrastructure/email/email.service';
import { AccountEntity } from '../../database/entities/account.entity';
import { RoleEntity } from '../../database/entities/role.entity';
import { SessionEntity } from '../../database/entities/session.entity';
import { UserEntity } from '../../database/entities/user.entity';
import { UserRoleEntity } from '../../database/entities/user-role.entity';
import { VerificationEntity } from '../../database/entities/verification.entity';
import { UsersService } from '../users/users.service';

type RepositoryMock<T extends object> = Pick<
  Repository<T>,
  'create' | 'find' | 'findOne' | 'save' | 'update'
> & {
  create: jest.Mock;
  find: jest.Mock;
  findOne: jest.Mock;
  save: jest.Mock;
  update: jest.Mock;
};

function createRepositoryMock<T extends object>(): RepositoryMock<T> {
  return {
    create: jest.fn((input) => input),
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn((input) => Promise.resolve(input)),
    update: jest.fn(),
  } as unknown as RepositoryMock<T>;
}

describe('AuthService', () => {
  const baseUser: UserEntity = {
    id: 'user-1',
    email: 'user@example.com',
    emailNormalized: 'user@example.com',
    fullName: 'User Example',
    avatarUrl: null,
    status: 'ACTIVE',
    isEmailVerified: false,
    isActive: true,
    lastLoginAt: null,
    createdAt: new Date(),
    updatedAt: null,
    deletedAt: null,
  };

  function setup() {
    const users = createRepositoryMock<UserEntity>();
    const accounts = createRepositoryMock<AccountEntity>();
    const sessions = createRepositoryMock<SessionEntity>();
    const roles = createRepositoryMock<RoleEntity>();
    const userRoles = createRepositoryMock<UserRoleEntity>();
    const verifications = createRepositoryMock<VerificationEntity>();
    const jwt = { signAsync: jest.fn().mockResolvedValue('access-token') };
    const config = {
      get: jest.fn((key: string) => {
        const values: Record<string, unknown> = {
          GOOGLE_CLIENT_ID: 'google-client',
          JWT_ACCESS_SECRET: 'jwt-access-secret-at-least-16',
          JWT_ACCESS_TTL: 3600,
          JWT_REFRESH_TTL: 604800,
          FRONTEND_BASE_URL: 'http://localhost:8080',
          EMAIL_VERIFY_TOKEN_TTL_SECONDS: 86400,
          PASSWORD_RESET_TOKEN_TTL_SECONDS: 1800,
        };
        return values[key];
      }),
    } as unknown as ConfigService;
    const email = {
      sendVerifyEmail: jest.fn().mockResolvedValue(undefined),
      sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
    };
    const usersService = { getCurrentUserAggregate: jest.fn() };

    const service = new AuthService(
      users as unknown as Repository<UserEntity>,
      accounts as unknown as Repository<AccountEntity>,
      sessions as unknown as Repository<SessionEntity>,
      roles as unknown as Repository<RoleEntity>,
      userRoles as unknown as Repository<UserRoleEntity>,
      verifications as unknown as Repository<VerificationEntity>,
      jwt as unknown as JwtService,
      config,
      email as unknown as EmailService,
      usersService as unknown as UsersService,
    );

    return {
      service,
      users,
      accounts,
      sessions,
      roles,
      userRoles,
      verifications,
      email,
      usersService,
    };
  }

  it('blocks credentials login until email is verified', async () => {
    const { service, users, accounts, userRoles } = setup();
    users.findOne.mockResolvedValue({ ...baseUser, isEmailVerified: false });
    accounts.findOne.mockResolvedValue({
      userId: baseUser.id,
      provider: 'CREDENTIALS',
      passwordHash: await bcrypt.hash('StrongPass123!', 4),
    });
    userRoles.find.mockResolvedValue([]);

    await expect(service.login(baseUser.email, 'StrongPass123!')).rejects.toThrow(
      UnauthorizedException,
    );
    await expect(service.login(baseUser.email, 'StrongPass123!')).rejects.toMatchObject({
      response: expect.objectContaining({ errorCode: 'EMAIL_NOT_VERIFIED' }),
    });
  });

  it('returns a clear generic message for invalid credentials', async () => {
    const { service, users } = setup();
    users.findOne.mockResolvedValue(null);

    await expect(service.login('missing@example.com', 'wrong-password')).rejects.toMatchObject({
      response: expect.objectContaining({
        errorCode: 'INVALID_CREDENTIALS',
        message: 'Incorrect email or password',
      }),
    });
  });

  it('verifies a valid email token and marks the token as used', async () => {
    const { service, users, verifications } = setup();
    const token = 'plain-verification-token';
    const verification = {
      id: 'verification-1',
      userId: baseUser.id,
      purpose: 'EMAIL_VERIFY',
      valueHash: 'hash',
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
      attemptCount: 0,
      createdAt: new Date(),
    };
    verifications.findOne.mockResolvedValue(verification);
    users.findOne.mockResolvedValue({ ...baseUser, isEmailVerified: false });

    await expect(service.verifyEmail(token)).resolves.toEqual({ verified: true });
    expect(users.save).toHaveBeenCalledWith(expect.objectContaining({ isEmailVerified: true }));
    expect(verifications.save).toHaveBeenCalledWith(
      expect.objectContaining({ usedAt: expect.any(Date) }),
    );
  });

  it('accepts forgot-password requests without revealing whether an account exists', async () => {
    const { service, users, accounts, email } = setup();
    users.findOne.mockResolvedValue(null);

    await expect(service.forgotPassword('missing@example.com')).resolves.toEqual({
      accepted: true,
    });
    expect(accounts.findOne).not.toHaveBeenCalled();
    expect(email.sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('sends a reset link only for an active credentials account', async () => {
    const { service, users, accounts, verifications, email } = setup();
    users.findOne.mockResolvedValue({ ...baseUser, isActive: true });
    accounts.findOne.mockResolvedValue({
      id: 'account-1',
      userId: baseUser.id,
      provider: 'CREDENTIALS',
      providerAccountId: baseUser.emailNormalized,
      passwordHash: 'old-hash',
    });

    await expect(service.forgotPassword(baseUser.email)).resolves.toEqual({ accepted: true });

    expect(verifications.update).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: baseUser.id,
        purpose: 'PASSWORD_RESET',
        usedAt: expect.anything(),
      }),
      { usedAt: expect.any(Date) },
    );
    expect(verifications.save).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: baseUser.id,
        purpose: 'PASSWORD_RESET',
        usedAt: null,
      }),
    );
    expect(email.sendPasswordResetEmail).toHaveBeenCalledWith(
      baseUser.email,
      expect.stringContaining('/reset-password?token='),
    );
  });

  it('resets the credentials password, consumes the token, and revokes existing sessions', async () => {
    const { service, users, accounts, sessions, verifications } = setup();
    verifications.findOne.mockResolvedValue({
      id: 'verification-1',
      userId: baseUser.id,
      purpose: 'PASSWORD_RESET',
      valueHash: 'hash',
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
      attemptCount: 0,
      createdAt: new Date(),
    });
    users.findOne.mockResolvedValue({ ...baseUser, isActive: true });
    accounts.findOne.mockResolvedValue({
      id: 'account-1',
      userId: baseUser.id,
      provider: 'CREDENTIALS',
      providerAccountId: baseUser.emailNormalized,
      passwordHash: 'old-hash',
    });

    await expect(service.resetPassword('plain-reset-token', 'NewStrongPass123')).resolves.toEqual({
      reset: true,
    });

    expect(accounts.save).toHaveBeenCalledWith(
      expect.objectContaining({ passwordHash: expect.any(String) }),
    );
    expect(verifications.save).toHaveBeenCalledWith(
      expect.objectContaining({ usedAt: expect.any(Date) }),
    );
    expect(sessions.update).toHaveBeenCalledWith(
      expect.objectContaining({ userId: baseUser.id, revokedAt: expect.anything() }),
      { revokedAt: expect.any(Date) },
    );
  });

  it('returns the current user aggregate for /auth/me', async () => {
    const { service, usersService } = setup();
    const aggregate = {
      id: baseUser.id,
      email: baseUser.email,
      displayName: baseUser.fullName,
      avatarUrl: null,
      roles: ['USER'],
      isEmailVerified: true,
      profile: {
        university: null,
        major: null,
        experienceYears: null,
        targetJob: null,
        careerGoal: null,
        githubUrl: null,
        linkedinUrl: null,
        portfolioUrl: null,
      },
      skills: [],
    };
    usersService.getCurrentUserAggregate.mockResolvedValue(aggregate);

    await expect(service.me(baseUser.id)).resolves.toBe(aggregate);
    expect(usersService.getCurrentUserAggregate).toHaveBeenCalledWith(baseUser.id);
  });

  it('normalizes uploaded avatar keys in login responses', async () => {
    const { service, users, accounts, sessions, userRoles } = setup();
    users.findOne.mockResolvedValue({
      ...baseUser,
      avatarUrl: 'avatars/user-1/avatar',
      isEmailVerified: true,
    });
    accounts.findOne.mockResolvedValue({
      userId: baseUser.id,
      provider: 'CREDENTIALS',
      passwordHash: await bcrypt.hash('StrongPass123!', 4),
    });
    userRoles.find.mockResolvedValue([]);
    sessions.save.mockResolvedValue({});

    const result = await service.login(baseUser.email, 'StrongPass123!');

    expect(result.user.avatarUrl).toBe('/api/users/me/avatar');
  });
});

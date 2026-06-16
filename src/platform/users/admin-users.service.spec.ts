import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { AccountEntity } from '../../database/entities/account.entity';
import { CvEntity } from '../../database/entities/cv.entity';
import { CvMatchEntity } from '../../database/entities/cv-match.entity';
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
import { AdminUsersService } from './admin-users.service';

type RepositoryMock<T extends object> = Pick<
  Repository<T>,
  'count' | 'create' | 'delete' | 'find' | 'findAndCount' | 'findOne' | 'save' | 'update'
> & {
  count: jest.Mock;
  create: jest.Mock;
  delete: jest.Mock;
  find: jest.Mock;
  findAndCount: jest.Mock;
  findOne: jest.Mock;
  manager: { transaction: jest.Mock };
  save: jest.Mock;
  update: jest.Mock;
};

function createRepositoryMock<T extends object>(): RepositoryMock<T> {
  const repo = {
    count: jest.fn().mockResolvedValue(0),
    create: jest.fn((input) => input),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    find: jest.fn().mockResolvedValue([]),
    findAndCount: jest.fn().mockResolvedValue([[], 0]),
    findOne: jest.fn().mockResolvedValue(null),
    manager: { transaction: jest.fn() },
    save: jest.fn((input) => Promise.resolve(input)),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  } as unknown as RepositoryMock<T>;
  repo.manager.transaction.mockImplementation(async (callback) =>
    callback({ getRepository: jest.fn().mockReturnValue(repo) }),
  );
  return repo;
}

const userRole: RoleEntity = {
  id: 'role-user',
  code: 'USER',
  name: 'User',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

const adminRole: RoleEntity = {
  id: 'role-admin',
  code: 'ADMIN',
  name: 'Admin',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

const mentorRole: RoleEntity = {
  id: 'role-mentor',
  code: 'MENTOR',
  name: 'Mentor',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

const baseUser: UserEntity = {
  id: 'user-1',
  email: 'user@example.com',
  emailNormalized: 'user@example.com',
  fullName: 'User Example',
  avatarUrl: null,
  status: 'ACTIVE',
  isEmailVerified: true,
  isActive: true,
  lastLoginAt: new Date('2026-06-10T00:00:00.000Z'),
  createdAt: new Date('2026-06-01T00:00:00.000Z'),
  updatedAt: null,
  deletedAt: null,
};

function setup() {
  const users = createRepositoryMock<UserEntity>();
  const profiles = createRepositoryMock<UserProfileEntity>();
  const userSkills = createRepositoryMock<UserSkillEntity>();
  const skills = createRepositoryMock<SkillEntity>();
  const roles = createRepositoryMock<RoleEntity>();
  const userRoles = createRepositoryMock<UserRoleEntity>();
  const accounts = createRepositoryMock<AccountEntity>();
  const sessions = createRepositoryMock<SessionEntity>();
  const cvs = createRepositoryMock<CvEntity>();
  const matches = createRepositoryMock<CvMatchEntity>();
  const interviews = createRepositoryMock<InterviewSessionEntity>();
  const orders = createRepositoryMock<PaymentOrderEntity>();
  const subscriptions = createRepositoryMock<UserSubscriptionEntity>();
  const usageEvents = createRepositoryMock<UsageEventEntity>();

  roles.find.mockResolvedValue([userRole, adminRole, mentorRole]);
  roles.findOne.mockImplementation(async ({ where }: { where?: { code?: string } }) => {
    if (where?.code === 'USER') return userRole;
    if (where?.code === 'ADMIN') return adminRole;
    if (where?.code === 'MENTOR') return mentorRole;
    return null;
  });

  const service = new AdminUsersService(
    users as unknown as Repository<UserEntity>,
    profiles as unknown as Repository<UserProfileEntity>,
    userSkills as unknown as Repository<UserSkillEntity>,
    skills as unknown as Repository<SkillEntity>,
    roles as unknown as Repository<RoleEntity>,
    userRoles as unknown as Repository<UserRoleEntity>,
    accounts as unknown as Repository<AccountEntity>,
    sessions as unknown as Repository<SessionEntity>,
    cvs as unknown as Repository<CvEntity>,
    matches as unknown as Repository<CvMatchEntity>,
    interviews as unknown as Repository<InterviewSessionEntity>,
    orders as unknown as Repository<PaymentOrderEntity>,
    subscriptions as unknown as Repository<UserSubscriptionEntity>,
    usageEvents as unknown as Repository<UsageEventEntity>,
  );

  return {
    service,
    users,
    profiles,
    userSkills,
    skills,
    roles,
    userRoles,
    accounts,
    sessions,
    cvs,
    matches,
    interviews,
    orders,
    subscriptions,
    usageEvents,
  };
}

describe('AdminUsersService', () => {
  it('lists users with role/status filters and aggregates row metrics', async () => {
    const { service, users, userRoles, roles, cvs, matches, interviews, orders, subscriptions } =
      setup();
    users.findAndCount.mockResolvedValue([[baseUser], 1]);
    userRoles.find.mockResolvedValue([{ id: 'ur-1', userId: 'user-1', roleId: 'role-user' }]);
    roles.find.mockResolvedValue([userRole]);
    cvs.find.mockResolvedValue([{ id: 'cv-1' }, { id: 'cv-2' }]);
    matches.count.mockResolvedValue(3);
    interviews.count.mockResolvedValue(4);
    orders.find.mockResolvedValue([{ amountVnd: 125000 }]);
    subscriptions.find.mockResolvedValue([{ planCode: 'PRO' }]);

    const result = await service.listUsers({
      role: 'USER',
      status: 'ACTIVE',
      search: 'user',
      page: 1,
      limit: 20,
    });

    expect(users.findAndCount).toHaveBeenCalled();
    expect(result.total).toBe(1);
    expect(result.items[0]).toEqual(
      expect.objectContaining({
        id: 'user-1',
        roles: ['USER'],
        status: 'ACTIVE',
        cvCount: 2,
        matchCount: 3,
        interviewCount: 4,
        paidAmountVnd: 125000,
        activePlanCodes: ['PRO'],
      }),
    );
  });

  it('suspends a user and revokes active refresh sessions', async () => {
    const { service, users, userRoles, roles, sessions } = setup();
    users.findOne.mockResolvedValue({ ...baseUser });
    userRoles.find.mockResolvedValue([{ id: 'ur-1', userId: 'user-1', roleId: 'role-user' }]);
    roles.find.mockResolvedValue([userRole]);

    const result = await service.updateUserStatus('admin-1', 'user-1', { status: 'SUSPENDED' });

    expect(users.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1', status: 'SUSPENDED', isActive: false }),
    );
    expect(sessions.update).toHaveBeenCalled();
    expect(result.status).toBe('SUSPENDED');
  });

  it('prevents suspending the last admin account', async () => {
    const { service, users, userRoles, roles } = setup();
    users.findOne.mockResolvedValue({ ...baseUser, id: 'admin-1' });
    userRoles.find
      .mockResolvedValueOnce([{ id: 'ur-1', userId: 'admin-1', roleId: 'role-admin' }])
      .mockResolvedValueOnce([{ id: 'ur-1', userId: 'admin-1', roleId: 'role-admin' }]);
    roles.find.mockResolvedValue([adminRole]);
    users.count.mockResolvedValue(1);

    await expect(
      service.updateUserStatus('admin-1', 'admin-1', { status: 'SUSPENDED' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('replaces roles in a transaction', async () => {
    const { service, users, userRoles } = setup();
    users.findOne.mockResolvedValue({ ...baseUser });
    userRoles.find.mockResolvedValue([{ id: 'ur-1', userId: 'user-1', roleId: 'role-user' }]);

    const result = await service.replaceUserRoles('admin-1', 'user-1', {
      roles: ['USER', 'MENTOR'],
    });

    expect(userRoles.delete).toHaveBeenCalledWith({ userId: 'user-1' });
    expect(userRoles.save).toHaveBeenCalledWith([
      expect.objectContaining({ userId: 'user-1', roleId: 'role-user' }),
      expect.objectContaining({ userId: 'user-1', roleId: 'role-mentor' }),
    ]);
    expect(userRoles.manager.transaction).toHaveBeenCalledTimes(1);
    expect(result.roles).toEqual(['USER', 'MENTOR']);
  });

  it('prevents removing the last admin role', async () => {
    const { service, users, userRoles, roles } = setup();
    users.findOne.mockResolvedValue({ ...baseUser, id: 'admin-1' });
    userRoles.find
      .mockResolvedValueOnce([{ id: 'ur-1', userId: 'admin-1', roleId: 'role-admin' }])
      .mockResolvedValueOnce([{ id: 'ur-1', userId: 'admin-1', roleId: 'role-admin' }]);
    roles.find.mockResolvedValue([adminRole]);
    users.count.mockResolvedValue(1);

    await expect(
      service.replaceUserRoles('admin-1', 'admin-1', { roles: ['USER'] }),
    ).rejects.toThrow(BadRequestException);
  });

  it('returns a summary for charts and KPI cards', async () => {
    const { service, users, userRoles, roles, cvs, matches, interviews, orders } = setup();
    users.find.mockResolvedValue([
      baseUser,
      {
        ...baseUser,
        id: 'user-2',
        email: 'pending@example.com',
        isEmailVerified: false,
        createdAt: new Date('2026-06-02T00:00:00.000Z'),
      },
    ]);
    userRoles.find.mockResolvedValue([
      { id: 'ur-1', userId: 'user-1', roleId: 'role-user' },
      { id: 'ur-2', userId: 'user-2', roleId: 'role-admin' },
    ]);
    roles.find.mockResolvedValue([userRole, adminRole]);
    cvs.count.mockResolvedValue(5);
    matches.count.mockResolvedValue(3);
    interviews.count.mockResolvedValue(2);
    orders.find.mockResolvedValue([
      { amountVnd: 100000, paidAt: new Date('2026-06-03T00:00:00.000Z') },
    ]);

    const result = await service.getSummary({ rangeDays: 30 });

    expect(result.totals.totalUsers).toBe(2);
    expect(result.totals.unverifiedUsers).toBe(1);
    expect(result.roleDistribution).toContainEqual({ role: 'ADMIN', count: 1 });
    expect(result.activityFunnel).toEqual(
      expect.arrayContaining([
        { label: 'Users', value: 2 },
        { label: 'CVs', value: 5 },
      ]),
    );
    expect(result.revenueTrend[0]).toEqual(expect.objectContaining({ amountVnd: 100000 }));
  });

  it('returns user detail with profile, providers, usage, and recent activity', async () => {
    const {
      service,
      users,
      profiles,
      userSkills,
      skills,
      userRoles,
      roles,
      accounts,
      usageEvents,
    } = setup();
    users.findOne.mockResolvedValue({ ...baseUser });
    profiles.findOne.mockResolvedValue({ userId: 'user-1', university: 'FPT University' });
    userRoles.find.mockResolvedValue([{ id: 'ur-1', userId: 'user-1', roleId: 'role-user' }]);
    roles.find.mockResolvedValue([userRole]);
    userSkills.find.mockResolvedValue([{ userId: 'user-1', skillId: 'skill-1', level: 4 }]);
    skills.find.mockResolvedValue([
      {
        id: 'skill-1',
        canonicalName: 'react',
        displayName: 'React',
        category: 'frontend_framework',
      },
    ]);
    accounts.find.mockResolvedValue([{ provider: 'GOOGLE' }]);
    usageEvents.find.mockResolvedValue([{ featureKey: 'cv_review', usedAt: new Date() }]);

    const result = await service.getUserDetail('user-1');

    expect(result.id).toBe('user-1');
    expect(result.profile).toEqual(expect.objectContaining({ university: 'FPT University' }));
    expect(result.authProviders).toEqual(['GOOGLE']);
    expect(result.skills).toEqual([expect.objectContaining({ displayName: 'React', level: 4 })]);
    expect(result.usageEvents).toHaveLength(1);
  });

  it('throws when the requested user does not exist', async () => {
    const { service, users } = setup();
    users.findOne.mockResolvedValue(null);

    await expect(service.getUserDetail('missing-user')).rejects.toThrow(NotFoundException);
  });
});

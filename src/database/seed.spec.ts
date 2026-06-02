import { AccountEntity } from './entities/account.entity';
import { RoleEntity } from './entities/role.entity';
import { SkillEntity } from './entities/skill.entity';
import { UserEntity } from './entities/user.entity';
import { UserRoleEntity } from './entities/user-role.entity';
import { seedDatabase } from './seed';

function createRepositoryMock() {
  return {
    create: jest.fn((input) => input),
    findOne: jest.fn(),
    save: jest.fn(async (input) => ({ id: crypto.randomUUID(), ...input })),
  };
}

describe('seedDatabase', () => {
  it('creates missing roles and two verified credentials users', async () => {
    const roles = createRepositoryMock();
    const users = createRepositoryMock();
    const accounts = createRepositoryMock();
    const userRoles = createRepositoryMock();
    const skills = createRepositoryMock();
    const dataSource = {
      getRepository: jest.fn((entity) => {
        if (entity === RoleEntity) return roles;
        if (entity === UserEntity) return users;
        if (entity === AccountEntity) return accounts;
        if (entity === UserRoleEntity) return userRoles;
        if (entity === SkillEntity) return skills;
        throw new Error('Unexpected repository');
      }),
    };

    await seedDatabase(dataSource as never, {
      defaultPassword: 'SkillBridge@123',
      adminEmail: 'admin@skillbridge.local',
      adminName: 'SkillBridge Admin',
      userEmail: 'user@skillbridge.local',
      userName: 'SkillBridge User',
    });

    expect(roles.save).toHaveBeenCalledWith(expect.objectContaining({ code: 'ADMIN' }));
    expect(roles.save).toHaveBeenCalledWith(expect.objectContaining({ code: 'USER' }));
    expect(users.save).toHaveBeenCalledWith(
      expect.objectContaining({
        emailNormalized: 'admin@skillbridge.local',
        isEmailVerified: true,
      }),
    );
    expect(users.save).toHaveBeenCalledWith(
      expect.objectContaining({
        emailNormalized: 'user@skillbridge.local',
        isEmailVerified: true,
      }),
    );
    expect(accounts.save).toHaveBeenCalledTimes(2);
    expect(userRoles.save).toHaveBeenCalledTimes(2);
  });

  it('does not duplicate existing roles, users, accounts, or user role links', async () => {
    const roles = createRepositoryMock();
    const users = createRepositoryMock();
    const accounts = createRepositoryMock();
    const userRoles = createRepositoryMock();
    const skills = createRepositoryMock();
    roles.findOne.mockResolvedValue({ id: 'role-1', code: 'USER', name: 'User' });
    users.findOne.mockResolvedValue({ id: 'user-1', emailNormalized: 'existing@example.com' });
    accounts.findOne.mockResolvedValue({ id: 'account-1' });
    userRoles.findOne.mockResolvedValue({ id: 'user-role-1' });
    skills.findOne.mockResolvedValue({ id: 'skill-1', canonicalName: 'react' });
    const dataSource = {
      getRepository: jest.fn((entity) => {
        if (entity === RoleEntity) return roles;
        if (entity === UserEntity) return users;
        if (entity === AccountEntity) return accounts;
        if (entity === UserRoleEntity) return userRoles;
        if (entity === SkillEntity) return skills;
        throw new Error('Unexpected repository');
      }),
    };

    await seedDatabase(dataSource as never, {
      defaultPassword: 'SkillBridge@123',
      adminEmail: 'admin@skillbridge.local',
      adminName: 'SkillBridge Admin',
      userEmail: 'user@skillbridge.local',
      userName: 'SkillBridge User',
    });

    expect(roles.save).not.toHaveBeenCalled();
    expect(users.save).not.toHaveBeenCalled();
    expect(accounts.save).not.toHaveBeenCalled();
    expect(userRoles.save).not.toHaveBeenCalled();
    expect(skills.save).not.toHaveBeenCalled();
  });
});

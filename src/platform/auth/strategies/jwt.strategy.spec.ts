import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { RoleEntity } from '../../../database/entities/role.entity';
import { UserEntity } from '../../../database/entities/user.entity';
import { UserRoleEntity } from '../../../database/entities/user-role.entity';
import { JwtStrategy } from './jwt.strategy';

function repo<T extends object>(overrides: Partial<Repository<T>> = {}) {
  return {
    find: jest.fn(),
    findOne: jest.fn(),
    ...overrides,
  } as unknown as Repository<T> & { find: jest.Mock; findOne: jest.Mock };
}

describe('JwtStrategy', () => {
  function setup() {
    const users = repo<UserEntity>();
    const roles = repo<RoleEntity>();
    const userRoles = repo<UserRoleEntity>();
    const strategy = new JwtStrategy(
      { get: jest.fn().mockReturnValue('test-secret') } as unknown as ConfigService,
      users,
      roles,
      userRoles,
    );
    return { strategy, users, roles, userRoles };
  }

  it('loads current user status and roles from the database', async () => {
    const { strategy, users, roles, userRoles } = setup();
    users.findOne.mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      isActive: true,
      status: 'ACTIVE',
    });
    userRoles.find.mockResolvedValue([{ userId: 'user-1', roleId: 'role-admin' }]);
    roles.find.mockResolvedValue([{ id: 'role-admin', code: 'ADMIN' }]);

    await expect(
      strategy.validate({ sub: 'user-1', email: 'stale@example.com', roles: ['USER'] }),
    ).resolves.toEqual({ userId: 'user-1', email: 'user@example.com', roles: ['ADMIN'] });
  });

  it('rejects suspended users even when the JWT has valid claims', async () => {
    const { strategy, users } = setup();
    users.findOne.mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      isActive: false,
      status: 'SUSPENDED',
    });

    await expect(
      strategy.validate({ sub: 'user-1', email: 'user@example.com', roles: ['ADMIN'] }),
    ).rejects.toThrow(UnauthorizedException);
  });
});

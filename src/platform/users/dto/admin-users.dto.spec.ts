import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  AdminListUsersQueryDto,
  AdminUserSummaryQueryDto,
  ReplaceAdminUserRolesDto,
  UpdateAdminUserStatusDto,
} from './admin-users.dto';

describe('Admin users DTOs', () => {
  it('accepts list filters and transforms pagination/range values', async () => {
    const dto = plainToInstance(AdminListUsersQueryDto, {
      page: '2',
      limit: '50',
      search: 'user@example.com',
      role: 'USER',
      status: 'ACTIVE',
      createdFrom: '2026-06-01',
      createdTo: '2026-06-15',
    });

    await expect(validate(dto)).resolves.toEqual([]);
    expect(dto.page).toBe(2);
    expect(dto.limit).toBe(50);
  });

  it('rejects invalid status and role update payloads', async () => {
    const statusDto = plainToInstance(UpdateAdminUserStatusDto, { status: 'DELETED' });
    const rolesDto = plainToInstance(ReplaceAdminUserRolesDto, { roles: [] });

    await expect(validate(statusDto)).resolves.not.toEqual([]);
    await expect(validate(rolesDto)).resolves.not.toEqual([]);
  });

  it('accepts the supported summary ranges', async () => {
    const dto = plainToInstance(AdminUserSummaryQueryDto, { rangeDays: '90' });

    await expect(validate(dto)).resolves.toEqual([]);
    expect(dto.rangeDays).toBe(90);
  });
});

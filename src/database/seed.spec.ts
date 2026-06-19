import { AccountEntity } from './entities/account.entity';
import { MentorProfileEntity } from './entities/mentor-profile.entity';
import { MentorProfileSkillEntity } from './entities/mentor-profile-skill.entity';
import { RoleEntity } from './entities/role.entity';
import { SkillEntity } from './entities/skill.entity';
import { UserEntity } from './entities/user.entity';
import { UserRoleEntity } from './entities/user-role.entity';
import { MENTOR_SEEDS } from './mentor-seeds';
import { seedDatabase } from './seed';

function createRepositoryMock() {
  return {
    create: jest.fn((input) => input),
    findOne: jest.fn(),
    save: jest.fn(async (input) => ({ id: crypto.randomUUID(), ...input })),
  };
}

describe('seedDatabase', () => {
  it('creates six approved mentor profiles with only one mentor credentials account', async () => {
    const roles = createRepositoryMock();
    const users = createRepositoryMock();
    const accounts = createRepositoryMock();
    const userRoles = createRepositoryMock();
    const skills = createRepositoryMock();
    const mentorProfiles = createRepositoryMock();
    const mentorProfileSkills = createRepositoryMock();
    skills.findOne.mockImplementation(async ({ where }) => {
      const canonicalName = (where as { canonicalName?: string })?.canonicalName;
      return canonicalName ? { id: `skill-${canonicalName}`, canonicalName } : null;
    });
    const dataSource = {
      getRepository: jest.fn((entity) => {
        if (entity === RoleEntity) return roles;
        if (entity === UserEntity) return users;
        if (entity === AccountEntity) return accounts;
        if (entity === UserRoleEntity) return userRoles;
        if (entity === SkillEntity) return skills;
        if (entity === MentorProfileEntity) return mentorProfiles;
        if (entity === MentorProfileSkillEntity) return mentorProfileSkills;
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
    expect(users.save).toHaveBeenCalledTimes(8);
    expect(accounts.save).toHaveBeenCalledTimes(3);
    expect(accounts.save.mock.calls.map(([account]) => account.providerAccountId)).toEqual(
      expect.arrayContaining([
        'admin@skillbridge.local',
        'user@skillbridge.local',
        'mentor@skillbridge.com',
      ]),
    );
    expect(
      accounts.save.mock.calls.filter(([account]) =>
        String(account.providerAccountId).endsWith('@skillbridge.com'),
      ),
    ).toHaveLength(1);
    expect(userRoles.save).toHaveBeenCalledTimes(8);
    expect(mentorProfiles.save).toHaveBeenCalledTimes(6);
    expect(mentorProfiles.save.mock.calls.every(([profile]) => profile.status === 'APPROVED')).toBe(
      true,
    );
    expect(mentorProfileSkills.save).toHaveBeenCalled();
  });

  it('refreshes existing mentor seed data without creating duplicate rows or links', async () => {
    const roles = createRepositoryMock();
    const users = createRepositoryMock();
    const accounts = createRepositoryMock();
    const userRoles = createRepositoryMock();
    const skills = createRepositoryMock();
    const mentorProfiles = createRepositoryMock();
    const mentorProfileSkills = createRepositoryMock();
    roles.findOne.mockResolvedValue({ id: 'role-1', code: 'USER', name: 'User' });
    users.findOne.mockResolvedValue({ id: 'user-1', emailNormalized: 'existing@example.com' });
    accounts.findOne.mockResolvedValue({ id: 'account-1' });
    userRoles.findOne.mockResolvedValue({ id: 'user-role-1' });
    skills.findOne.mockResolvedValue({ id: 'skill-1', canonicalName: 'react' });
    mentorProfiles.findOne.mockResolvedValue({ id: 'mentor-profile-1', slug: 'existing-mentor' });
    mentorProfileSkills.findOne.mockResolvedValue({ id: 'mentor-skill-1' });
    const dataSource = {
      getRepository: jest.fn((entity) => {
        if (entity === RoleEntity) return roles;
        if (entity === UserEntity) return users;
        if (entity === AccountEntity) return accounts;
        if (entity === UserRoleEntity) return userRoles;
        if (entity === SkillEntity) return skills;
        if (entity === MentorProfileEntity) return mentorProfiles;
        if (entity === MentorProfileSkillEntity) return mentorProfileSkills;
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
    expect(users.create).not.toHaveBeenCalled();
    expect(accounts.save).not.toHaveBeenCalled();
    expect(userRoles.save).not.toHaveBeenCalled();
    expect(skills.save).not.toHaveBeenCalled();
    expect(mentorProfiles.create).not.toHaveBeenCalled();
    expect(mentorProfileSkills.save).not.toHaveBeenCalled();
  });

  it('stores stock portrait URLs in seeded mentor users', () => {
    expect(MENTOR_SEEDS).toHaveLength(6);
    expect(MENTOR_SEEDS.filter((mentor) => mentor.hasCredentials)).toEqual([
      expect.objectContaining({ email: 'mentor@skillbridge.com' }),
    ]);
    expect(
      MENTOR_SEEDS.every(
        (mentor) =>
          mentor.avatarUrl.startsWith('https://images.unsplash.com/photo-') &&
          mentor.avatarUrl.includes('fit=crop'),
      ),
    ).toBe(true);
    expect(
      MENTOR_SEEDS.every(
        (mentor) =>
          mentor.linkedinUrl.startsWith('https://www.linkedin.com/in/') && mentor.phoneNumber,
      ),
    ).toBe(true);
  });
});

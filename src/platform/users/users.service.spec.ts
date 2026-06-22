import {
  BadRequestException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { RoleEntity } from '../../database/entities/role.entity';
import { SkillEntity } from '../../database/entities/skill.entity';
import { UserLearningPreferenceEntity } from '../../database/entities/user-learning-preference.entity';
import { UserEntity } from '../../database/entities/user.entity';
import { UserProfileEntity } from '../../database/entities/user-profile.entity';
import { UserRoleEntity } from '../../database/entities/user-role.entity';
import { UserSkillEntity } from '../../database/entities/user-skill.entity';
import { GcsStorageService } from '../../infrastructure/storage/gcs-storage.service';
import { UsersService } from './users.service';

type RepositoryMock<T extends object> = Pick<
  Repository<T>,
  'create' | 'delete' | 'find' | 'findOne' | 'save'
> & {
  create: jest.Mock;
  delete: jest.Mock;
  find: jest.Mock;
  findOne: jest.Mock;
  manager: {
    transaction: jest.Mock;
  };
  save: jest.Mock;
};

function createRepositoryMock<T extends object>(): RepositoryMock<T> {
  return {
    create: jest.fn((input) => input),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(),
    manager: {
      transaction: jest.fn(),
    },
    save: jest.fn((input) => Promise.resolve(input)),
  } as unknown as RepositoryMock<T>;
}

describe('UsersService', () => {
  const baseUser: UserEntity = {
    id: 'user-1',
    email: 'user@example.com',
    emailNormalized: 'user@example.com',
    fullName: 'User Example',
    avatarUrl: null,
    status: 'ACTIVE',
    isEmailVerified: true,
    isActive: true,
    lastLoginAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: null,
    deletedAt: null,
  };

  const reactSkill: SkillEntity = {
    id: 'skill-1',
    inDemand: false,
    canonicalName: 'react',
    displayName: 'React',
    category: 'frontend_framework',
    source: 'CUSTOM',
    sourceExternalId: null,
    aliases: ['react.js'],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: null,
  };

  function setup() {
    const users = createRepositoryMock<UserEntity>();
    const profiles = createRepositoryMock<UserProfileEntity>();
    const userSkills = createRepositoryMock<UserSkillEntity>();
    const skills = createRepositoryMock<SkillEntity>();
    const roles = createRepositoryMock<RoleEntity>();
    const userRoles = createRepositoryMock<UserRoleEntity>();
    const learningPreferences = createRepositoryMock<UserLearningPreferenceEntity>();
    const storage = {
      buildAvatarObjectKey: jest.fn().mockReturnValue('avatars/user-1/avatar'),
      upload: jest.fn().mockResolvedValue({ bucket: 'bucket', key: 'avatars/user-1/avatar' }),
      delete: jest.fn().mockResolvedValue(undefined),
      download: jest.fn(),
    };

    users.findOne.mockResolvedValue({ ...baseUser });
    profiles.findOne.mockResolvedValue(null);
    learningPreferences.findOne.mockResolvedValue(null);
    userSkills.find.mockResolvedValue([]);
    userRoles.find.mockResolvedValue([]);

    const service = new UsersService(
      users as unknown as Repository<UserEntity>,
      profiles as unknown as Repository<UserProfileEntity>,
      userSkills as unknown as Repository<UserSkillEntity>,
      skills as unknown as Repository<SkillEntity>,
      roles as unknown as Repository<RoleEntity>,
      userRoles as unknown as Repository<UserRoleEntity>,
      learningPreferences as unknown as Repository<UserLearningPreferenceEntity>,
      storage as unknown as GcsStorageService,
    );
    userSkills.manager.transaction.mockImplementation(async (callback) =>
      callback({ getRepository: jest.fn().mockReturnValue(userSkills) }),
    );

    return {
      service,
      users,
      profiles,
      userSkills,
      skills,
      roles,
      userRoles,
      learningPreferences,
      storage,
    };
  }

  it('upserts profile fields and trims string input for the current user', async () => {
    const { service, users, profiles } = setup();

    const result = await service.updateProfile('user-1', {
      displayName: '  Updated User  ',
      university: '  FPT University  ',
      major: null,
      experienceYears: 1,
      targetJob: '  Frontend Developer  ',
      careerGoal: null,
      githubUrl: 'https://github.com/skillbridge',
    });

    expect(users.save).toHaveBeenCalledWith(expect.objectContaining({ fullName: 'Updated User' }));
    expect(profiles.save).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        university: 'FPT University',
        major: null,
        experienceYears: 1,
        targetJob: 'Frontend Developer',
        careerGoal: null,
        githubUrl: 'https://github.com/skillbridge',
      }),
    );
    expect(result.profile).toEqual(
      expect.objectContaining({
        university: 'FPT University',
        major: null,
        targetJob: 'Frontend Developer',
      }),
    );
    expect(result.learningPreferences).toEqual({
      language_pref: 'both',
      available_days: 30,
      hours_per_week: 8,
    });
  });

  it('returns default learning preferences when no persisted row exists', async () => {
    const { service } = setup();

    await expect(service.getLearningPreferences('user-1')).resolves.toEqual({
      language_pref: 'both',
      available_days: 30,
      hours_per_week: 8,
    });
  });

  it('upserts learning preferences for the current user', async () => {
    const { service, learningPreferences } = setup();

    const result = await service.updateLearningPreferences('user-1', {
      language_pref: 'en',
      available_days: 45,
      hours_per_week: 12,
    });

    expect(learningPreferences.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
    );
    expect(learningPreferences.save).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        languagePref: 'en',
        availableDays: 45,
        hoursPerWeek: 12,
      }),
    );
    expect(result).toEqual({
      language_pref: 'en',
      available_days: 45,
      hours_per_week: 12,
    });
  });

  it('rejects duplicate skill ids when replacing current user skills', async () => {
    const { service } = setup();

    await expect(
      service.replaceSkills('user-1', {
        skills: [
          { skillId: 'skill-1', level: 3 },
          { skillId: 'skill-1', level: 4 },
        ],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('replaces current user skills with validated skill ids and levels', async () => {
    const { service, skills, userSkills } = setup();
    skills.find.mockResolvedValue([reactSkill]);

    const result = await service.replaceSkills('user-1', {
      skills: [{ skillId: 'skill-1', level: 3 }],
    });

    expect(userSkills.delete).toHaveBeenCalledWith({ userId: 'user-1' });
    expect(userSkills.save).toHaveBeenCalledWith([
      expect.objectContaining({ userId: 'user-1', skillId: 'skill-1', level: 3 }),
    ]);
    expect(userSkills.manager.transaction).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      expect.objectContaining({
        id: 'skill-1',
        canonicalName: 'react',
        displayName: 'React',
        level: 3,
      }),
    ]);
  });

  it('escapes SQL LIKE wildcards when searching skills', async () => {
    const { service, skills } = setup();
    skills.find.mockResolvedValue([]);

    await service.listSkills({ query: '%_', limit: 10 });

    expect(skills.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: [
          expect.objectContaining({
            canonicalName: expect.objectContaining({ _value: '%\\%\\_%' }),
          }),
          expect.objectContaining({
            displayName: expect.objectContaining({ _value: '%\\%\\_%' }),
          }),
        ],
      }),
    );
  });

  it('rejects unsupported avatar file types', async () => {
    const { service } = setup();

    await expect(
      service.uploadAvatar('user-1', {
        originalname: 'avatar.txt',
        mimetype: 'text/plain',
        size: 10,
        buffer: Buffer.from('avatar'),
      } as Express.Multer.File),
    ).rejects.toThrow(UnsupportedMediaTypeException);
  });

  it('rejects avatar files larger than two megabytes', async () => {
    const { service } = setup();

    await expect(
      service.uploadAvatar('user-1', {
        originalname: 'avatar.png',
        mimetype: 'image/png',
        size: 2 * 1024 * 1024 + 1,
        buffer: Buffer.from('avatar'),
      } as Express.Multer.File),
    ).rejects.toThrow(PayloadTooLargeException);
  });

  it('uploads avatar to private storage and exposes it through the backend URL', async () => {
    const { service, storage, users } = setup();

    const result = await service.uploadAvatar('user-1', {
      originalname: 'avatar.png',
      mimetype: 'image/png',
      size: 128,
      buffer: Buffer.from('avatar'),
    } as Express.Multer.File);

    expect(storage.buildAvatarObjectKey).toHaveBeenCalledWith(
      'user-1',
      expect.stringMatching(/avatar\.png$/),
    );
    expect(storage.upload).toHaveBeenCalledWith({
      key: 'avatars/user-1/avatar',
      body: expect.any(Buffer),
      contentType: 'image/png',
    });
    expect(users.save).toHaveBeenCalledWith(
      expect.objectContaining({ avatarUrl: 'avatars/user-1/avatar' }),
    );
    expect(result.avatarUrl).toBe('/api/users/me/avatar');
  });

  it('does not delete the old avatar until the database update succeeds', async () => {
    const { service, storage, users } = setup();
    users.findOne.mockResolvedValue({ ...baseUser, avatarUrl: 'avatars/user-1/old-avatar' });

    await service.uploadAvatar('user-1', {
      originalname: 'avatar.png',
      mimetype: 'image/png',
      size: 128,
      buffer: Buffer.from('avatar'),
    } as Express.Multer.File);

    expect(users.save).toHaveBeenCalled();
    expect(storage.delete).toHaveBeenCalledWith('avatars/user-1/old-avatar');
    expect(users.save.mock.invocationCallOrder[0]).toBeLessThan(
      storage.delete.mock.invocationCallOrder[0],
    );
  });

  it('deletes the newly uploaded avatar when saving the database row fails', async () => {
    const { service, storage, users } = setup();
    users.findOne.mockResolvedValue({ ...baseUser, avatarUrl: 'avatars/user-1/old-avatar' });
    users.save.mockRejectedValueOnce(new Error('db down'));

    await expect(
      service.uploadAvatar('user-1', {
        originalname: 'avatar.png',
        mimetype: 'image/png',
        size: 128,
        buffer: Buffer.from('avatar'),
      } as Express.Multer.File),
    ).rejects.toThrow('db down');

    expect(storage.delete).toHaveBeenCalledWith('avatars/user-1/avatar');
    expect(storage.delete).not.toHaveBeenCalledWith('avatars/user-1/old-avatar');
  });
});

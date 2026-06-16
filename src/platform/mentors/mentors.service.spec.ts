import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { SkillEntity } from '../../database/entities/skill.entity';
import { UserEntity } from '../../database/entities/user.entity';
import { MentorProfileEntity } from '../../database/entities/mentor-profile.entity';
import { MentorProfileSkillEntity } from '../../database/entities/mentor-profile-skill.entity';
import { MentorsService } from './mentors.service';

type RepositoryManagerMock = {
  getRepository: jest.Mock;
  transaction: jest.Mock;
};

type RepositoryMock<T extends object> = Pick<
  Repository<T>,
  'count' | 'create' | 'delete' | 'find' | 'findAndCount' | 'findOne' | 'save'
> & {
  count: jest.Mock;
  create: jest.Mock;
  delete: jest.Mock;
  find: jest.Mock;
  findAndCount: jest.Mock;
  findOne: jest.Mock;
  manager: RepositoryManagerMock;
  save: jest.Mock;
};

function createRepositoryMock<T extends object>(): RepositoryMock<T> {
  return {
    count: jest.fn().mockResolvedValue(0),
    create: jest.fn((input) => input),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    find: jest.fn().mockResolvedValue([]),
    findAndCount: jest.fn().mockResolvedValue([[], 0]),
    findOne: jest.fn().mockResolvedValue(null),
    manager: {
      getRepository: jest.fn(),
      transaction: jest.fn(),
    },
    save: jest.fn((input) => Promise.resolve(input)),
  } as unknown as RepositoryMock<T>;
}

const mentorUser: UserEntity = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'mentor@example.com',
  emailNormalized: 'mentor@example.com',
  fullName: 'Nguyen Minh An',
  avatarUrl: 'https://cdn.example.com/avatar.png',
  status: 'ACTIVE',
  isEmailVerified: true,
  isActive: true,
  lastLoginAt: null,
  createdAt: new Date('2026-06-01T00:00:00.000Z'),
  updatedAt: null,
  deletedAt: null,
};

const reactSkill: SkillEntity = {
  id: 'skill-react',
  canonicalName: 'react',
  displayName: 'React',
  category: 'frontend_framework',
  source: 'seed',
  sourceExternalId: null,
  aliases: null,
  inDemand: true,
  createdAt: new Date('2026-06-01T00:00:00.000Z'),
  updatedAt: null,
};

const approvedProfile: MentorProfileEntity = {
  id: 'profile-1',
  userId: mentorUser.id,
  slug: 'nguyen-minh-an-11111111',
  status: 'APPROVED',
  headline: 'Senior Frontend Engineer',
  company: 'Momo',
  shortBio: 'I help frontend engineers grow faster.',
  bio: 'Long mentor bio',
  domainTags: ['Technology & Software'],
  sessionPriceVnd: 380000,
  sessionDurationMinutes: 60,
  currency: 'VND',
  isAcceptingBookings: true,
  ratingAverage: 4.8,
  reviewCount: 12,
  completedSessions: 24,
  submittedAt: new Date('2026-06-02T00:00:00.000Z'),
  approvedAt: new Date('2026-06-03T00:00:00.000Z'),
  approvedBy: 'admin-1',
  rejectionReason: null,
  createdAt: new Date('2026-06-01T00:00:00.000Z'),
  updatedAt: null,
};

function setup() {
  const profiles = createRepositoryMock<MentorProfileEntity>();
  const profileSkills = createRepositoryMock<MentorProfileSkillEntity>();
  const users = createRepositoryMock<UserEntity>();
  const skills = createRepositoryMock<SkillEntity>();
  const manager: RepositoryManagerMock = {
    getRepository: jest.fn(),
    transaction: jest.fn(),
  };
  manager.getRepository.mockImplementation((entity: unknown) => {
    if (entity === MentorProfileEntity) return profiles;
    if (entity === MentorProfileSkillEntity) return profileSkills;
    if (entity === UserEntity) return users;
    if (entity === SkillEntity) return skills;
    throw new Error('Unknown repository');
  });
  manager.transaction.mockImplementation(
    async (callback: (manager: RepositoryManagerMock) => unknown) => callback(manager),
  );
  profiles.manager = manager;
  profileSkills.manager = manager;
  users.manager = manager;
  skills.manager = manager;
  const service = new MentorsService(
    profiles as unknown as Repository<MentorProfileEntity>,
    profileSkills as unknown as Repository<MentorProfileSkillEntity>,
    users as unknown as Repository<UserEntity>,
    skills as unknown as Repository<SkillEntity>,
  );
  return { service, profiles, profileSkills, users, skills };
}

describe('MentorsService public marketplace', () => {
  it('lists only approved mentor cards with user, skills, and pricing data', async () => {
    const { service, profiles, profileSkills, users, skills } = setup();
    profiles.findAndCount.mockResolvedValue([[approvedProfile], 1]);
    users.find.mockResolvedValue([mentorUser]);
    profileSkills.find.mockResolvedValue([
      { id: 'link-1', mentorProfileId: 'profile-1', skillId: 'skill-react', sortOrder: 0 },
    ]);
    skills.find.mockResolvedValue([reactSkill]);

    const result = await service.listPublicMentors({ page: 1, limit: 10 });

    expect(profiles.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'APPROVED' }),
        order: {
          reviewCount: 'DESC',
          ratingAverage: 'DESC',
          createdAt: 'DESC',
        },
      }),
    );
    expect(result.total).toBe(1);
    expect(result.items[0]).toEqual(
      expect.objectContaining({
        slug: 'nguyen-minh-an-11111111',
        displayName: 'Nguyen Minh An',
        avatarUrl: 'https://cdn.example.com/avatar.png',
        sessionPriceVnd: 380000,
        sessionDurationMinutes: 60,
        currency: 'VND',
        verified: true,
        skills: [expect.objectContaining({ id: 'skill-react', displayName: 'React' })],
      }),
    );
  });

  it('searches by mentor user text before building profile query filters', async () => {
    const { service, profiles, users } = setup();
    profiles.findAndCount.mockResolvedValue([[], 0]);
    users.find.mockResolvedValue([mentorUser]);

    await service.listPublicMentors({
      query: 'Nguyen',
      domain: 'Technology & Software',
      minRating: 4,
      sort: 'rating_desc',
    });

    expect(users.find).toHaveBeenCalled();
    expect(profiles.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.any(Array),
        order: expect.objectContaining({ ratingAverage: 'DESC' }),
      }),
    );
  });

  it('does not expose a missing or non-approved profile detail', async () => {
    const { service, profiles } = setup();
    profiles.findOne.mockResolvedValue(null);

    await expect(service.getPublicProfile('draft-profile')).rejects.toThrow(NotFoundException);
  });

  it('returns summary stats with a spotlight mentor', async () => {
    const { service, profiles, profileSkills, users, skills } = setup();
    profiles.find.mockResolvedValue([approvedProfile]);
    users.find.mockResolvedValue([mentorUser]);
    profileSkills.find.mockResolvedValue([
      { id: 'link-1', mentorProfileId: 'profile-1', skillId: 'skill-react', sortOrder: 0 },
    ]);
    skills.find.mockResolvedValue([reactSkill]);

    const result = await service.getPublicSummary();

    expect(profiles.find).toHaveBeenCalledWith(
      expect.objectContaining({
        order: {
          reviewCount: 'DESC',
          ratingAverage: 'DESC',
          completedSessions: 'DESC',
          createdAt: 'DESC',
        },
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        verifiedExperts: 1,
        sessionsCompleted: 24,
        averageRating: 4.8,
        spotlightMentor: expect.objectContaining({ slug: 'nguyen-minh-an-11111111' }),
      }),
    );
  });
});

describe('MentorsService profile management', () => {
  it('creates the current mentor profile and replaces expertise skills', async () => {
    const { service, profiles, profileSkills, users, skills } = setup();
    users.findOne.mockResolvedValue(mentorUser);
    profiles.findOne.mockResolvedValue(null);
    profiles.save.mockImplementation(async (profile) => ({
      ...profile,
      id: 'profile-1',
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
      updatedAt: null,
    }));
    skills.find.mockResolvedValue([reactSkill]);

    const result = await service.updateMyProfile(mentorUser.id, {
      headline: 'Senior Frontend Engineer',
      company: 'Momo',
      shortBio: 'I help frontend engineers grow faster.',
      bio: 'Long mentor bio',
      domainTags: ['Technology & Software'],
      sessionPriceVnd: 380000,
      sessionDurationMinutes: 60,
      isAcceptingBookings: true,
      skillIds: ['skill-react'],
    });

    expect(profiles.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: mentorUser.id,
        slug: 'nguyen-minh-an-11111111',
        status: 'DRAFT',
      }),
    );
    expect(profileSkills.delete).toHaveBeenCalledWith({ mentorProfileId: 'profile-1' });
    expect(profileSkills.save).toHaveBeenCalledWith([
      expect.objectContaining({ mentorProfileId: 'profile-1', skillId: 'skill-react' }),
    ]);
    expect(result).toEqual(expect.objectContaining({ status: 'DRAFT', sessionPriceVnd: 380000 }));
  });

  it('rejects unknown skill ids when updating a mentor profile', async () => {
    const { service, profiles, users, skills } = setup();
    users.findOne.mockResolvedValue(mentorUser);
    skills.find.mockResolvedValue([]);

    await expect(
      service.updateMyProfile(mentorUser.id, { skillIds: ['missing-skill'] }),
    ).rejects.toThrow(BadRequestException);
    expect(profiles.save).not.toHaveBeenCalled();
  });

  it('requires complete public fields and skills before submitting for review', async () => {
    const { service, profiles, profileSkills } = setup();
    profiles.findOne.mockResolvedValue({ ...approvedProfile, status: 'DRAFT', headline: null });
    profileSkills.count.mockResolvedValue(1);

    await expect(service.submitMyProfile(mentorUser.id)).rejects.toThrow(BadRequestException);
  });

  it('moves a complete draft profile into pending review', async () => {
    const { service, profiles, profileSkills } = setup();
    profiles.findOne.mockResolvedValue({ ...approvedProfile, status: 'DRAFT' });
    profileSkills.count.mockResolvedValue(1);

    const result = await service.submitMyProfile(mentorUser.id);

    expect(profiles.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'PENDING_REVIEW', rejectionReason: null }),
    );
    expect(result.status).toBe('PENDING_REVIEW');
  });
});

describe('MentorsService admin review', () => {
  it('approves a pending mentor profile and makes it verified', async () => {
    const { service, profiles } = setup();
    profiles.findOne.mockResolvedValue({ ...approvedProfile, status: 'PENDING_REVIEW' });

    const result = await service.updateAdminStatus('admin-1', 'profile-1', {
      status: 'APPROVED',
    });

    expect(profiles.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'APPROVED', approvedBy: 'admin-1', rejectionReason: null }),
    );
    expect(result.verified).toBe(true);
  });

  it('stores rejection reason when an admin rejects a profile', async () => {
    const { service, profiles } = setup();
    profiles.findOne.mockResolvedValue({ ...approvedProfile, status: 'PENDING_REVIEW' });

    const result = await service.updateAdminStatus('admin-1', 'profile-1', {
      status: 'REJECTED',
      rejectionReason: 'Please add more work history.',
    });

    expect(profiles.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'REJECTED',
        approvedAt: null,
        approvedBy: null,
        rejectionReason: 'Please add more work history.',
      }),
    );
    expect(result.rejectionReason).toBe('Please add more work history.');
  });
});

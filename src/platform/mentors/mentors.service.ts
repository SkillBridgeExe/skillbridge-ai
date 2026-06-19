import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  ArrayContains,
  FindOptionsOrder,
  FindOptionsWhere,
  ILike,
  In,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';
import { ERROR_CODES } from '../../common/constants/error-codes';
import {
  MentorProfileEntity,
  MentorProfileStatus,
} from '../../database/entities/mentor-profile.entity';
import { MentorProfileSkillEntity } from '../../database/entities/mentor-profile-skill.entity';
import { SkillEntity } from '../../database/entities/skill.entity';
import { UserEntity } from '../../database/entities/user.entity';
import {
  DownloadedFile,
  GcsStorageService,
} from '../../infrastructure/storage/gcs-storage.service';
import {
  AdminListMentorsQueryDto,
  AdminMentorListDto,
  ListMentorsQueryDto,
  MentorCardDto,
  MentorFiltersDto,
  MentorListDto,
  MentorProfileDto,
  MentorPublicProfileDto,
  MentorSkillDto,
  MentorSummaryDto,
  UpdateAdminMentorStatusDto,
  UpdateMentorProfileDto,
} from './dto/mentor-profile.dto';

const PUBLIC_STATUS: MentorProfileStatus = 'APPROVED';
const EDITABLE_SUBMIT_STATUSES: MentorProfileStatus[] = ['DRAFT', 'REJECTED'];
const DEFAULT_SESSION_PRICE_VND = 50000;
const DEFAULT_SESSION_DURATION_MINUTES = 60;

@Injectable()
export class MentorsService {
  constructor(
    @InjectRepository(MentorProfileEntity)
    private readonly profiles: Repository<MentorProfileEntity>,
    @InjectRepository(MentorProfileSkillEntity)
    private readonly profileSkills: Repository<MentorProfileSkillEntity>,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectRepository(SkillEntity) private readonly skills: Repository<SkillEntity>,
    private readonly storage: GcsStorageService,
  ) {}

  async getPublicSummary(): Promise<MentorSummaryDto> {
    const profiles = await this.profiles.find({
      where: { status: PUBLIC_STATUS },
      order: {
        reviewCount: 'DESC',
        ratingAverage: 'DESC',
        completedSessions: 'DESC',
        createdAt: 'DESC',
      },
    });
    const sessionsCompleted = profiles.reduce((sum, profile) => sum + profile.completedSessions, 0);
    const ratedProfiles = profiles.filter(
      (profile) => profile.ratingAverage !== null && profile.reviewCount > 0,
    );
    const reviewCount = ratedProfiles.reduce((sum, profile) => sum + profile.reviewCount, 0);
    const weightedRating =
      reviewCount > 0
        ? ratedProfiles.reduce(
            (sum, profile) => sum + Number(profile.ratingAverage) * profile.reviewCount,
            0,
          ) / reviewCount
        : null;
    const spotlightMentor = profiles.length
      ? (await this.mapProfilesToCards([profiles[0]]))[0]
      : null;

    return {
      verifiedExperts: profiles.length,
      sessionsCompleted,
      averageRating: weightedRating === null ? null : roundOneDecimal(weightedRating),
      spotlightMentor,
    };
  }

  async getPublicFilters(): Promise<MentorFiltersDto> {
    const profiles = await this.profiles.find({ where: { status: PUBLIC_STATUS } });
    const counts = new Map<string, number>();
    for (const profile of profiles) {
      for (const domain of profile.domainTags ?? []) {
        counts.set(domain, (counts.get(domain) ?? 0) + 1);
      }
    }
    return {
      domains: [...counts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([domain, mentorCount]) => ({
          value: domain,
          label: domain,
          mentorCount,
        })),
    };
  }

  async listPublicMentors(query: ListMentorsQueryDto = {}): Promise<MentorListDto> {
    const { page, limit, skip } = pagination(query.page, query.limit, 12, 50);
    const where = await this.buildPublicWhere(query);
    const [profiles, total] = await this.profiles.findAndCount({
      where,
      order: this.publicOrder(query.sort),
      skip,
      take: limit,
    });
    return {
      items: await this.mapProfilesToCards(profiles),
      total,
      page,
      limit,
    };
  }

  async getPublicProfile(slug: string): Promise<MentorPublicProfileDto> {
    const profile = await this.profiles.findOne({
      where: { slug, status: PUBLIC_STATUS },
    });
    if (!profile) throw new NotFoundException('Mentor profile not found');
    return (await this.mapProfilesToPublicDetails([profile]))[0];
  }

  async getPublicAvatar(slug: string): Promise<DownloadedFile> {
    const profile = await this.profiles.findOne({ where: { slug, status: PUBLIC_STATUS } });
    if (!profile) throw new NotFoundException('Mentor profile not found');
    return this.downloadStoredAvatar(profile.userId);
  }

  async getAdminAvatar(profileId: string): Promise<DownloadedFile> {
    const profile = await this.profiles.findOne({ where: { id: profileId } });
    if (!profile) throw new NotFoundException('Mentor profile not found');
    return this.downloadStoredAvatar(profile.userId);
  }

  async getMyProfile(userId: string): Promise<MentorProfileDto | null> {
    await this.requireActiveUser(userId);
    const profile = await this.profiles.findOne({ where: { userId } });
    if (!profile) return null;
    return (await this.mapProfilesToDetails([profile], 'self'))[0];
  }

  async updateMyProfile(userId: string, dto: UpdateMentorProfileDto): Promise<MentorProfileDto> {
    const user = await this.requireActiveUser(userId);
    const skillIds = hasOwn(dto, 'skillIds')
      ? await this.validateSkillIds(dto.skillIds ?? [])
      : null;

    const saveProfile = async (
      profiles: Repository<MentorProfileEntity>,
      profileSkills: Repository<MentorProfileSkillEntity>,
    ) => {
      let profile = await profiles.findOne({ where: { userId } });
      if (!profile) {
        profile = profiles.create({
          userId,
          slug: this.slugForUser(user),
          status: 'DRAFT',
          headline: null,
          company: null,
          shortBio: null,
          bio: null,
          linkedinUrl: null,
          phoneNumber: null,
          domainTags: [],
          sessionPriceVnd: DEFAULT_SESSION_PRICE_VND,
          sessionDurationMinutes: DEFAULT_SESSION_DURATION_MINUTES,
          currency: 'VND',
          isAcceptingBookings: true,
          ratingAverage: null,
          reviewCount: 0,
          completedSessions: 0,
          submittedAt: null,
          approvedAt: null,
          approvedBy: null,
          rejectionReason: null,
        });
      }

      if (hasOwn(dto, 'headline')) profile.headline = cleanNullableString(dto.headline);
      if (hasOwn(dto, 'company')) profile.company = cleanNullableString(dto.company);
      if (hasOwn(dto, 'shortBio')) profile.shortBio = cleanNullableString(dto.shortBio);
      if (hasOwn(dto, 'bio')) profile.bio = cleanNullableString(dto.bio);
      if (hasOwn(dto, 'linkedinUrl')) profile.linkedinUrl = cleanNullableString(dto.linkedinUrl);
      if (hasOwn(dto, 'phoneNumber')) profile.phoneNumber = cleanNullableString(dto.phoneNumber);
      if (hasOwn(dto, 'domainTags')) profile.domainTags = normalizeTags(dto.domainTags ?? []);
      if (hasOwn(dto, 'sessionPriceVnd') && dto.sessionPriceVnd !== undefined) {
        profile.sessionPriceVnd = dto.sessionPriceVnd;
      }
      if (hasOwn(dto, 'sessionDurationMinutes') && dto.sessionDurationMinutes !== undefined) {
        profile.sessionDurationMinutes = dto.sessionDurationMinutes;
      }
      if (hasOwn(dto, 'isAcceptingBookings') && dto.isAcceptingBookings !== undefined) {
        profile.isAcceptingBookings = dto.isAcceptingBookings;
      }

      const saved = await profiles.save(profile);
      if (skillIds !== null) {
        await this.replaceProfileSkills(profileSkills, saved.id, skillIds);
      }
      return saved;
    };

    const saved =
      skillIds === null
        ? await saveProfile(this.profiles, this.profileSkills)
        : await this.profiles.manager.transaction(async (manager) =>
            saveProfile(
              manager.getRepository(MentorProfileEntity),
              manager.getRepository(MentorProfileSkillEntity),
            ),
          );

    return (await this.mapProfilesToDetails([saved], 'self'))[0];
  }

  async submitMyProfile(userId: string): Promise<MentorProfileDto> {
    const profile = await this.profiles.findOne({ where: { userId } });
    if (!profile) throw new NotFoundException('Mentor profile not found');
    if (!EDITABLE_SUBMIT_STATUSES.includes(profile.status)) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.VALIDATION_ERROR,
        message: 'Only draft or rejected mentor profiles can be submitted',
      });
    }

    const skillCount = await this.profileSkills.count({ where: { mentorProfileId: profile.id } });
    this.assertReadyForReview(profile, skillCount);
    profile.status = 'PENDING_REVIEW';
    profile.submittedAt = new Date();
    profile.rejectionReason = null;
    const saved = await this.profiles.save(profile);
    return (await this.mapProfilesToDetails([saved], 'self'))[0];
  }

  async listAdminProfiles(query: AdminListMentorsQueryDto = {}): Promise<AdminMentorListDto> {
    const { page, limit, skip } = pagination(query.page, query.limit, 20, 100);
    const where = this.buildAdminWhere(query);
    const [profiles, total] = await this.profiles.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip,
      take: limit,
    });
    return {
      items: await this.mapProfilesToDetails(profiles, 'admin'),
      total,
      page,
      limit,
    };
  }

  async updateAdminStatus(
    adminUserId: string,
    profileId: string,
    dto: UpdateAdminMentorStatusDto,
  ): Promise<MentorProfileDto> {
    const profile = await this.profiles.findOne({ where: { id: profileId } });
    if (!profile) throw new NotFoundException('Mentor profile not found');

    if (dto.status === 'REJECTED') {
      const reason = cleanNullableString(dto.rejectionReason);
      if (!reason) {
        throw new BadRequestException({
          errorCode: ERROR_CODES.VALIDATION_ERROR,
          message: 'rejectionReason is required when rejecting a mentor profile',
        });
      }
      profile.status = 'REJECTED';
      profile.approvedAt = null;
      profile.approvedBy = null;
      profile.rejectionReason = reason;
    } else if (dto.status === 'APPROVED') {
      profile.status = 'APPROVED';
      profile.approvedAt = new Date();
      profile.approvedBy = adminUserId;
      profile.rejectionReason = null;
    } else {
      profile.status = 'SUSPENDED';
      profile.rejectionReason = cleanNullableString(dto.rejectionReason);
    }

    const saved = await this.profiles.save(profile);
    return (await this.mapProfilesToDetails([saved], 'admin'))[0];
  }

  private async buildPublicWhere(
    query: ListMentorsQueryDto,
  ): Promise<FindOptionsWhere<MentorProfileEntity> | FindOptionsWhere<MentorProfileEntity>[]> {
    const base = this.publicBaseWhere(query);
    const search = query.query?.trim();
    if (!search) return base;

    const userIds = await this.findUserIdsBySearch(search);
    const pattern = `%${escapeSqlLike(search)}%`;
    const where: FindOptionsWhere<MentorProfileEntity>[] = [
      { ...base, headline: ILike(pattern) },
      { ...base, company: ILike(pattern) },
      { ...base, shortBio: ILike(pattern) },
      { ...base, bio: ILike(pattern) },
    ];
    if (userIds.length > 0) where.push({ ...base, userId: In(userIds) });
    return where;
  }

  private publicBaseWhere(query: ListMentorsQueryDto): FindOptionsWhere<MentorProfileEntity> {
    const where: FindOptionsWhere<MentorProfileEntity> = { status: PUBLIC_STATUS };
    const domain = query.domain?.trim();
    if (domain) where.domainTags = ArrayContains([domain]);
    if (query.minRating !== undefined) where.ratingAverage = MoreThanOrEqual(query.minRating);
    return where;
  }

  private buildAdminWhere(
    query: AdminListMentorsQueryDto,
  ): FindOptionsWhere<MentorProfileEntity> | FindOptionsWhere<MentorProfileEntity>[] {
    const base: FindOptionsWhere<MentorProfileEntity> = {};
    if (query.status) base.status = query.status;
    const search = query.query?.trim();
    if (!search) return base;
    const pattern = `%${escapeSqlLike(search)}%`;
    return [
      { ...base, slug: ILike(pattern) },
      { ...base, headline: ILike(pattern) },
      { ...base, company: ILike(pattern) },
      { ...base, shortBio: ILike(pattern) },
      { ...base, bio: ILike(pattern) },
    ];
  }

  private publicOrder(sort?: string): FindOptionsOrder<MentorProfileEntity> {
    if (sort === 'price_asc') {
      return { sessionPriceVnd: 'ASC', ratingAverage: 'DESC', createdAt: 'DESC' };
    }
    if (sort === 'price_desc') {
      return { sessionPriceVnd: 'DESC', ratingAverage: 'DESC', createdAt: 'DESC' };
    }
    if (sort === 'newest') return { createdAt: 'DESC' };
    return { reviewCount: 'DESC', ratingAverage: 'DESC', createdAt: 'DESC' };
  }

  private async findUserIdsBySearch(search: string): Promise<string[]> {
    const pattern = `%${escapeSqlLike(search)}%`;
    const users = await this.users.find({
      where: [{ fullName: ILike(pattern) }, { email: ILike(pattern) }],
    });
    return users.map((user) => user.id);
  }

  private async validateSkillIds(skillIds: string[]): Promise<string[]> {
    const uniqueSkillIds = [...new Set(skillIds)];
    if (uniqueSkillIds.length !== skillIds.length) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.VALIDATION_ERROR,
        message: 'Duplicate skill ids are not allowed',
      });
    }

    if (uniqueSkillIds.length > 0) {
      const existingSkills = await this.skills.find({ where: { id: In(uniqueSkillIds) } });
      const existingSkillIds = new Set(existingSkills.map((skill) => skill.id));
      const missing = uniqueSkillIds.filter((skillId) => !existingSkillIds.has(skillId));
      if (missing.length > 0) {
        throw new BadRequestException({
          errorCode: ERROR_CODES.VALIDATION_ERROR,
          message: 'One or more mentor skills do not exist',
          errors: { skillIds: [`Unknown skill ids: ${missing.join(', ')}`] },
        });
      }
    }
    return uniqueSkillIds;
  }

  private async replaceProfileSkills(
    profileSkills: Repository<MentorProfileSkillEntity>,
    profileId: string,
    skillIds: string[],
  ): Promise<void> {
    await profileSkills.delete({ mentorProfileId: profileId });
    const rows = skillIds.map((skillId, sortOrder) =>
      profileSkills.create({ mentorProfileId: profileId, skillId, sortOrder }),
    );
    if (rows.length > 0) await profileSkills.save(rows);
  }

  private assertReadyForReview(profile: MentorProfileEntity, skillCount: number): void {
    const missing: string[] = [];
    if (!cleanNullableString(profile.headline)) missing.push('headline');
    if (!cleanNullableString(profile.shortBio)) missing.push('shortBio');
    if (!cleanNullableString(profile.linkedinUrl) && !cleanNullableString(profile.phoneNumber)) {
      missing.push('verificationContact');
    }
    if (!profile.domainTags?.length) missing.push('domainTags');
    if (!profile.sessionPriceVnd) missing.push('sessionPriceVnd');
    if (!profile.sessionDurationMinutes) missing.push('sessionDurationMinutes');
    if (skillCount < 1) missing.push('skillIds');
    if (missing.length > 0) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.VALIDATION_ERROR,
        message: 'Mentor profile is missing required public fields',
        errors: { fields: missing },
      });
    }
  }

  private async mapProfilesToCards(profiles: MentorProfileEntity[]): Promise<MentorCardDto[]> {
    const context = await this.loadMappingContext(profiles);
    return profiles.map((profile) => this.toCard(profile, context, 'public'));
  }

  private async mapProfilesToPublicDetails(
    profiles: MentorProfileEntity[],
  ): Promise<MentorPublicProfileDto[]> {
    const context = await this.loadMappingContext(profiles);
    return profiles.map((profile) => ({
      ...this.toCard(profile, context, 'public'),
      bio: profile.bio,
      linkedinUrl: profile.linkedinUrl,
    }));
  }

  private async mapProfilesToDetails(
    profiles: MentorProfileEntity[],
    scope: Exclude<AvatarScope, 'public'>,
  ): Promise<MentorProfileDto[]> {
    const context = await this.loadMappingContext(profiles);
    return profiles.map((profile) => ({
      ...this.toCard(profile, context, scope),
      bio: profile.bio,
      linkedinUrl: profile.linkedinUrl,
      phoneNumber: profile.phoneNumber,
      status: profile.status,
      rejectionReason: profile.rejectionReason,
      submittedAt: profile.submittedAt?.toISOString() ?? null,
      approvedAt: profile.approvedAt?.toISOString() ?? null,
      createdAt: profile.createdAt.toISOString(),
      updatedAt: profile.updatedAt?.toISOString() ?? null,
    }));
  }

  private async loadMappingContext(profiles: MentorProfileEntity[]): Promise<MappingContext> {
    if (profiles.length === 0) {
      return { users: new Map(), skillsByProfile: new Map() };
    }

    const userIds = [...new Set(profiles.map((profile) => profile.userId))];
    const profileIds = profiles.map((profile) => profile.id);
    const [users, links] = await Promise.all([
      this.users.find({ where: { id: In(userIds) } }),
      this.profileSkills.find({
        where: { mentorProfileId: In(profileIds) },
        order: { sortOrder: 'ASC' },
      }),
    ]);
    const skillIds = [...new Set(links.map((link) => link.skillId))];
    const skills =
      skillIds.length > 0 ? await this.skills.find({ where: { id: In(skillIds) } }) : [];
    const skillById = new Map(skills.map((skill) => [skill.id, skill]));
    const skillsByProfile = new Map<string, MentorSkillDto[]>();
    for (const link of links) {
      const skill = skillById.get(link.skillId);
      if (!skill) continue;
      const current = skillsByProfile.get(link.mentorProfileId) ?? [];
      current.push({
        id: skill.id,
        displayName: skill.displayName,
        category: skill.category,
      });
      skillsByProfile.set(link.mentorProfileId, current);
    }
    return {
      users: new Map(users.map((user) => [user.id, user])),
      skillsByProfile,
    };
  }

  private toCard(
    profile: MentorProfileEntity,
    context: MappingContext,
    scope: AvatarScope,
  ): MentorCardDto {
    const user = context.users.get(profile.userId);
    return {
      id: profile.id,
      slug: profile.slug,
      displayName: user?.fullName ?? user?.email ?? profile.slug,
      avatarUrl: this.avatarUrl(profile, user?.avatarUrl ?? null, scope),
      headline: profile.headline,
      company: profile.company,
      shortBio: profile.shortBio,
      domains: profile.domainTags ?? [],
      skills: context.skillsByProfile.get(profile.id) ?? [],
      ratingAverage: profile.ratingAverage,
      reviewCount: profile.reviewCount,
      completedSessions: profile.completedSessions,
      sessionPriceVnd: profile.sessionPriceVnd,
      sessionDurationMinutes: profile.sessionDurationMinutes,
      currency: profile.currency,
      isAcceptingBookings: profile.isAcceptingBookings,
      verified: profile.status === 'APPROVED',
    };
  }

  private async requireActiveUser(userId: string): Promise<UserEntity> {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user || !user.isActive) {
      throw new UnauthorizedException({
        errorCode: ERROR_CODES.UNAUTHORIZED,
        message: 'User is not authorized',
      });
    }
    return user;
  }

  private async downloadStoredAvatar(userId: string): Promise<DownloadedFile> {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user || !this.isStoredAvatar(user.avatarUrl)) {
      throw new NotFoundException('Mentor avatar not found');
    }
    return this.storage.download(user.avatarUrl);
  }

  private avatarUrl(
    profile: MentorProfileEntity,
    value: string | null,
    scope: AvatarScope,
  ): string | null {
    if (!value || !this.isStoredAvatar(value)) return value;
    if (scope === 'self') return '/api/users/me/avatar';
    if (scope === 'admin') return `/api/admin/mentors/${profile.id}/avatar`;
    return `/api/mentors/${profile.slug}/avatar`;
  }

  private isStoredAvatar(value: string | null): value is string {
    return typeof value === 'string' && value.startsWith('avatars/');
  }

  private slugForUser(user: UserEntity): string {
    const base = slugify(user.fullName ?? user.email.split('@')[0] ?? 'mentor');
    return `${base || 'mentor'}-${user.id.slice(0, 8)}`;
  }
}

interface MappingContext {
  users: Map<string, UserEntity>;
  skillsByProfile: Map<string, MentorSkillDto[]>;
}

type AvatarScope = 'public' | 'self' | 'admin';

function pagination(
  pageInput: number | undefined,
  limitInput: number | undefined,
  defaultLimit: number,
  maxLimit: number,
) {
  const page = Math.max(Number(pageInput) || 1, 1);
  const limit = Math.min(Math.max(Number(limitInput) || defaultLimit, 1), maxLimit);
  return { page, limit, skip: (page - 1) * limit };
}

function cleanNullableString(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeTags(tags: string[]): string[] {
  const normalized: string[] = [];
  for (const tag of tags) {
    const trimmed = tag.trim();
    if (!trimmed || normalized.includes(trimmed)) continue;
    normalized.push(trimmed);
  }
  return normalized;
}

function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function escapeSqlLike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function roundOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

function hasOwn<T extends object>(object: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

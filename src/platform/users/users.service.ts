import {
  BadRequestException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  UnauthorizedException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { FindOptionsWhere, ILike, In, Repository } from 'typeorm';
import { RoleEntity } from '../../database/entities/role.entity';
import { SkillEntity } from '../../database/entities/skill.entity';
import {
  LearningLanguagePref,
  UserLearningPreferenceEntity,
} from '../../database/entities/user-learning-preference.entity';
import { UserEntity } from '../../database/entities/user.entity';
import { UserProfileEntity } from '../../database/entities/user-profile.entity';
import { UserRoleEntity } from '../../database/entities/user-role.entity';
import { UserSkillEntity } from '../../database/entities/user-skill.entity';
import { ERROR_CODES } from '../../common/constants/error-codes';
import {
  DownloadedFile,
  GcsStorageService,
} from '../../infrastructure/storage/gcs-storage.service';
import { ReplaceUserSkillsDto } from './dto/replace-user-skills.dto';
import { SkillListQueryDto } from './dto/skill-list-query.dto';
import { UpdateLearningPreferencesDto } from './dto/update-learning-preferences.dto';
import { UpdateUserProfileDto } from './dto/update-user-profile.dto';
import {
  AvatarResponseDto,
  CurrentUserProfileResponseDto,
  LearningPreferencesResponseDto,
  SkillPickerItemDto,
  UserProfileResponseDto,
  UserSkillResponseDto,
} from './dto/user-profile-response.dto';

const MAX_AVATAR_FILE_BYTES = 2 * 1024 * 1024;
const SUPPORTED_AVATAR_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);

type ProfileField =
  | 'university'
  | 'major'
  | 'experienceYears'
  | 'targetJob'
  | 'careerGoal'
  | 'githubUrl'
  | 'linkedinUrl'
  | 'portfolioUrl';

const PROFILE_FIELDS: ProfileField[] = [
  'university',
  'major',
  'experienceYears',
  'targetJob',
  'careerGoal',
  'githubUrl',
  'linkedinUrl',
  'portfolioUrl',
];

export const DEFAULT_LEARNING_PREFERENCES: LearningPreferencesResponseDto = {
  language_pref: 'both',
  available_days: 30,
  hours_per_week: 8,
};

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectRepository(UserProfileEntity)
    private readonly profiles: Repository<UserProfileEntity>,
    @InjectRepository(UserSkillEntity)
    private readonly userSkills: Repository<UserSkillEntity>,
    @InjectRepository(SkillEntity) private readonly skills: Repository<SkillEntity>,
    @InjectRepository(RoleEntity) private readonly roles: Repository<RoleEntity>,
    @InjectRepository(UserRoleEntity) private readonly userRoles: Repository<UserRoleEntity>,
    @InjectRepository(UserLearningPreferenceEntity)
    private readonly learningPreferences: Repository<UserLearningPreferenceEntity>,
    private readonly storage: GcsStorageService,
  ) {}

  async getCurrentUserAggregate(userId: string): Promise<CurrentUserProfileResponseDto> {
    const user = await this.requireCurrentUser(userId);
    const [roles, profile, preferences, skills] = await Promise.all([
      this.roleCodes(userId),
      this.profiles.findOne({ where: { userId } }),
      this.getLearningPreferences(userId, { requireUser: false }),
      this.listCurrentUserSkills(userId),
    ]);
    return this.toCurrentUserResponse(user, roles, profile, preferences, skills);
  }

  async updateProfile(
    userId: string,
    dto: UpdateUserProfileDto,
  ): Promise<CurrentUserProfileResponseDto> {
    let user = await this.requireCurrentUser(userId);
    let profile = await this.profiles.findOne({ where: { userId } });

    if (hasOwn(dto, 'displayName')) {
      user.fullName = this.cleanNullableString(dto.displayName);
      user = await this.users.save(user);
    }

    if (PROFILE_FIELDS.some((field) => hasOwn(dto, field))) {
      profile = profile ?? this.profiles.create({ userId });

      for (const field of PROFILE_FIELDS) {
        if (!hasOwn(dto, field)) continue;
        if (field === 'experienceYears') {
          profile.experienceYears = dto.experienceYears ?? null;
        } else {
          profile[field] = this.cleanNullableString(dto[field]);
        }
      }
      profile = await this.profiles.save(profile);
    }

    const [roles, preferences, skills] = await Promise.all([
      this.roleCodes(user.id),
      this.getLearningPreferences(user.id, { requireUser: false }),
      this.listCurrentUserSkills(user.id),
    ]);
    return this.toCurrentUserResponse(user, roles, profile, preferences, skills);
  }

  async getLearningPreferences(
    userId: string,
    opts: { requireUser?: boolean } = {},
  ): Promise<LearningPreferencesResponseDto> {
    if (opts.requireUser !== false) await this.requireCurrentUser(userId);
    const prefs = await this.learningPreferences.findOne({ where: { userId } });
    return this.toLearningPreferencesResponse(prefs);
  }

  async updateLearningPreferences(
    userId: string,
    dto: UpdateLearningPreferencesDto,
  ): Promise<LearningPreferencesResponseDto> {
    await this.requireCurrentUser(userId);
    const current = await this.learningPreferences.findOne({ where: { userId } });
    const base = current ?? this.learningPreferences.create({ userId });
    const existing = this.toLearningPreferencesResponse(current);

    base.languagePref = (dto.language_pref ?? existing.language_pref) as LearningLanguagePref;
    base.availableDays = dto.available_days ?? existing.available_days;
    base.hoursPerWeek = dto.hours_per_week ?? existing.hours_per_week;

    const saved = await this.learningPreferences.save(base);
    return this.toLearningPreferencesResponse(saved);
  }

  async listCurrentUserSkills(userId: string): Promise<UserSkillResponseDto[]> {
    const links = await this.userSkills.find({ where: { userId } });
    if (links.length === 0) return [];

    const skillIds = links.map((link) => link.skillId);
    const skills = await this.skills.find({ where: { id: In(skillIds) } });
    const skillById = new Map(skills.map((skill) => [skill.id, skill]));

    return links
      .map((link) => {
        const skill = skillById.get(link.skillId);
        if (!skill) return null;
        return this.toUserSkillResponse(skill, link.level);
      })
      .filter((item): item is UserSkillResponseDto => item !== null);
  }

  async replaceSkills(userId: string, dto: ReplaceUserSkillsDto): Promise<UserSkillResponseDto[]> {
    await this.requireCurrentUser(userId);

    const skillIds = dto.skills.map((item) => item.skillId);
    const uniqueSkillIds = new Set(skillIds);
    if (uniqueSkillIds.size !== skillIds.length) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.VALIDATION_ERROR,
        message: 'Duplicate skill ids are not allowed',
        errors: { skills: ['Duplicate skill ids are not allowed'] },
      });
    }

    if (skillIds.length === 0) {
      await this.userSkills.delete({ userId });
      return [];
    }

    const existingSkills = await this.skills.find({ where: { id: In(skillIds) } });
    const skillById = new Map(existingSkills.map((skill) => [skill.id, skill]));
    const missingSkillIds = skillIds.filter((id) => !skillById.has(id));
    if (missingSkillIds.length > 0) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.VALIDATION_ERROR,
        message: 'One or more skills do not exist',
        errors: { skills: [`Unknown skill ids: ${missingSkillIds.join(', ')}`] },
      });
    }

    await this.userSkills.manager.transaction(async (manager) => {
      const userSkills = manager.getRepository(UserSkillEntity);
      await userSkills.delete({ userId });
      const rows = dto.skills.map((item) =>
        userSkills.create({
          userId,
          skillId: item.skillId,
          level: item.level,
        }),
      );
      await userSkills.save(rows);
    });

    return dto.skills.map((item) =>
      this.toUserSkillResponse(skillById.get(item.skillId)!, item.level),
    );
  }

  async listSkills(query: SkillListQueryDto): Promise<SkillPickerItemDto[]> {
    const search = query.query?.trim();
    const category = query.category?.trim();
    const take = query.limit ?? 20;
    const baseWhere: FindOptionsWhere<SkillEntity> = {};
    if (category) baseWhere.category = category;
    const escapedSearch = search ? escapeSqlLike(search) : null;

    const where: FindOptionsWhere<SkillEntity>[] | FindOptionsWhere<SkillEntity> = escapedSearch
      ? [
          { ...baseWhere, canonicalName: ILike(`%${escapedSearch}%`) },
          { ...baseWhere, displayName: ILike(`%${escapedSearch}%`) },
        ]
      : baseWhere;

    const rows = await this.skills.find({
      where,
      order: { displayName: 'ASC' },
      take,
    });
    return rows.map((skill) => this.toSkillPickerItem(skill));
  }

  async uploadAvatar(userId: string, file: Express.Multer.File): Promise<AvatarResponseDto> {
    this.validateAvatarFile(file);
    const user = await this.requireCurrentUser(userId);
    const previousAvatarUrl = user.avatarUrl;
    const objectKey = this.storage.buildAvatarObjectKey(
      userId,
      `${randomUUID()}-${file.originalname}`,
    );

    await this.storage.upload({
      key: objectKey,
      body: file.buffer,
      contentType: file.mimetype,
    });

    user.avatarUrl = objectKey;
    try {
      await this.users.save(user);
    } catch (error) {
      await this.storage.delete(objectKey).catch(() => undefined);
      throw error;
    }

    if (this.isUploadedAvatarKey(previousAvatarUrl) && previousAvatarUrl !== objectKey) {
      await this.storage.delete(previousAvatarUrl).catch(() => undefined);
    }
    return { avatarUrl: this.toPublicAvatarUrl(user.avatarUrl) };
  }

  async downloadAvatar(userId: string): Promise<{ user: UserEntity; file: DownloadedFile }> {
    const user = await this.requireCurrentUser(userId);
    if (!this.isUploadedAvatarKey(user.avatarUrl)) {
      throw new NotFoundException('Avatar not found');
    }
    return { user, file: await this.storage.download(user.avatarUrl) };
  }

  async removeAvatar(userId: string): Promise<AvatarResponseDto> {
    const user = await this.requireCurrentUser(userId);
    if (this.isUploadedAvatarKey(user.avatarUrl)) {
      await this.storage.delete(user.avatarUrl).catch(() => undefined);
    }
    user.avatarUrl = null;
    await this.users.save(user);
    return { avatarUrl: null };
  }

  private async requireCurrentUser(userId: string): Promise<UserEntity> {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user || !user.isActive) {
      throw new UnauthorizedException({
        errorCode: ERROR_CODES.UNAUTHORIZED,
        message: 'User is not authorized',
      });
    }
    return user;
  }

  private async roleCodes(userId: string): Promise<string[]> {
    const links = await this.userRoles.find({ where: { userId } });
    if (links.length === 0) return [];
    const roles = await this.roles.find({ where: { id: In(links.map((link) => link.roleId)) } });
    return roles.map((role) => role.code);
  }

  private toCurrentUserResponse(
    user: UserEntity,
    roles: string[],
    profile: UserProfileEntity | null,
    learningPreferences: LearningPreferencesResponseDto,
    skills: UserSkillResponseDto[],
  ): CurrentUserProfileResponseDto {
    return {
      id: user.id,
      email: user.email,
      displayName: user.fullName,
      avatarUrl: this.toPublicAvatarUrl(user.avatarUrl),
      roles,
      isEmailVerified: user.isEmailVerified,
      profile: this.toProfileResponse(profile),
      learningPreferences,
      skills,
    };
  }

  private toLearningPreferencesResponse(
    preferences: UserLearningPreferenceEntity | null,
  ): LearningPreferencesResponseDto {
    return {
      language_pref: preferences?.languagePref ?? DEFAULT_LEARNING_PREFERENCES.language_pref,
      available_days: preferences?.availableDays ?? DEFAULT_LEARNING_PREFERENCES.available_days,
      hours_per_week: preferences?.hoursPerWeek ?? DEFAULT_LEARNING_PREFERENCES.hours_per_week,
    };
  }

  private toProfileResponse(profile: UserProfileEntity | null): UserProfileResponseDto {
    return {
      university: profile?.university ?? null,
      major: profile?.major ?? null,
      experienceYears: profile?.experienceYears ?? null,
      targetJob: profile?.targetJob ?? null,
      careerGoal: profile?.careerGoal ?? null,
      githubUrl: profile?.githubUrl ?? null,
      linkedinUrl: profile?.linkedinUrl ?? null,
      portfolioUrl: profile?.portfolioUrl ?? null,
    };
  }

  private toUserSkillResponse(skill: SkillEntity, level: number): UserSkillResponseDto {
    return {
      id: skill.id,
      canonicalName: skill.canonicalName,
      displayName: skill.displayName,
      category: skill.category,
      level,
    };
  }

  private toSkillPickerItem(skill: SkillEntity): SkillPickerItemDto {
    return {
      id: skill.id,
      canonicalName: skill.canonicalName,
      displayName: skill.displayName,
      category: skill.category,
    };
  }

  private validateAvatarFile(
    file: Express.Multer.File | undefined,
  ): asserts file is Express.Multer.File {
    if (!file) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.VALIDATION_ERROR,
        message: 'Avatar file is required',
      });
    }
    if (file.size > MAX_AVATAR_FILE_BYTES) {
      throw new PayloadTooLargeException({
        errorCode: ERROR_CODES.FILE_TOO_LARGE,
        message: 'Avatar file must be 2MB or smaller',
      });
    }
    if (!SUPPORTED_AVATAR_MIME_TYPES.has(file.mimetype)) {
      throw new UnsupportedMediaTypeException({
        errorCode: ERROR_CODES.UNSUPPORTED_FILE_TYPE,
        message: 'Only PNG, JPG, and WEBP avatar files are supported',
      });
    }
  }

  private cleanNullableString(value: string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private toPublicAvatarUrl(avatarUrl: string | null): string | null {
    if (!avatarUrl) return null;
    return this.isUploadedAvatarKey(avatarUrl) ? '/api/users/me/avatar' : avatarUrl;
  }

  private isUploadedAvatarKey(value: string | null): value is string {
    return typeof value === 'string' && value.startsWith('avatars/');
  }
}

function hasOwn<T extends object>(object: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function escapeSqlLike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export interface UserProfileResponseDto {
  university: string | null;
  major: string | null;
  experienceYears: number | null;
  targetJob: string | null;
  careerGoal: string | null;
  githubUrl: string | null;
  linkedinUrl: string | null;
  portfolioUrl: string | null;
}

export interface UserSkillResponseDto {
  id: string;
  canonicalName: string;
  displayName: string;
  category: string | null;
  level: number;
}

export interface CurrentUserProfileResponseDto {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  roles: string[];
  isEmailVerified: boolean;
  profile: UserProfileResponseDto;
  skills: UserSkillResponseDto[];
}

export interface SkillPickerItemDto {
  id: string;
  canonicalName: string;
  displayName: string;
  category: string | null;
}

export interface AvatarResponseDto {
  avatarUrl: string | null;
}

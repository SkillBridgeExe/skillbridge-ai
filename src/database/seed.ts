import 'dotenv/config';
import * as bcrypt from 'bcrypt';
import * as fs from 'fs';
import * as path from 'path';
import { DataSource, Repository } from 'typeorm';
import dataSource from './data-source';
import { AccountEntity } from './entities/account.entity';
import { MentorProfileEntity } from './entities/mentor-profile.entity';
import { MentorProfileSkillEntity } from './entities/mentor-profile-skill.entity';
import { RoleCode, RoleEntity } from './entities/role.entity';
import { SkillEntity } from './entities/skill.entity';
import { UserEntity } from './entities/user.entity';
import { UserRoleEntity } from './entities/user-role.entity';
import { MENTOR_SEEDS, MentorSeed } from './mentor-seeds';

const ROLE_SEEDS: Array<{ code: RoleCode; name: string }> = [
  { code: 'USER', name: 'User' },
  { code: 'ADMIN', name: 'Admin' },
  { code: 'MENTOR', name: 'Mentor' },
  { code: 'BUSINESS', name: 'Business' },
];

export interface SeedOptions {
  defaultPassword: string;
  adminEmail: string;
  adminName: string;
  userEmail: string;
  userName: string;
}

interface SeedRepositories {
  roles: Repository<RoleEntity>;
  skills: Repository<SkillEntity>;
  users: Repository<UserEntity>;
  accounts: Repository<AccountEntity>;
  userRoles: Repository<UserRoleEntity>;
  mentorProfiles: Repository<MentorProfileEntity>;
  mentorProfileSkills: Repository<MentorProfileSkillEntity>;
}

interface SkillSeed {
  canonical_name: string;
  display_name: string;
  category?: string | null;
  source?: string | null;
  source_external_id?: string | null;
  aliases?: string[];
  in_demand?: boolean;
}

export async function seedDatabase(
  source: Pick<DataSource, 'getRepository'>,
  options = loadSeedOptions(),
): Promise<void> {
  const repos: SeedRepositories = {
    roles: source.getRepository(RoleEntity),
    skills: source.getRepository(SkillEntity),
    users: source.getRepository(UserEntity),
    accounts: source.getRepository(AccountEntity),
    userRoles: source.getRepository(UserRoleEntity),
    mentorProfiles: source.getRepository(MentorProfileEntity),
    mentorProfileSkills: source.getRepository(MentorProfileSkillEntity),
  };

  const roles = new Map<RoleCode, RoleEntity>();
  for (const seed of ROLE_SEEDS) {
    roles.set(seed.code, await ensureRole(repos.roles, seed.code, seed.name));
  }
  await seedSkills(repos.skills);

  const admin = await ensureCredentialsUser(repos, {
    email: options.adminEmail,
    fullName: options.adminName,
    password: options.defaultPassword,
  });
  const user = await ensureCredentialsUser(repos, {
    email: options.userEmail,
    fullName: options.userName,
    password: options.defaultPassword,
  });

  await ensureUserRole(repos.userRoles, admin.id, roles.get('ADMIN')!.id);
  await ensureUserRole(repos.userRoles, user.id, roles.get('USER')!.id);
  await seedMentors(repos, roles.get('MENTOR')!, admin.id, options.defaultPassword);
}

function loadSeedOptions(): SeedOptions {
  return {
    defaultPassword: process.env.SEED_DEFAULT_PASSWORD ?? 'SkillBridge@123',
    adminEmail: process.env.SEED_ADMIN_EMAIL ?? 'admin@skillbridge.com',
    adminName: process.env.SEED_ADMIN_NAME ?? 'SkillBridge Admin',
    userEmail: process.env.SEED_USER_EMAIL ?? 'user@skillbridge.com',
    userName: process.env.SEED_USER_NAME ?? 'SkillBridge User',
  };
}

async function ensureRole(
  roles: Repository<RoleEntity>,
  code: RoleCode,
  name: string,
): Promise<RoleEntity> {
  const existing = await roles.findOne({ where: { code } });
  if (existing) return existing;
  return roles.save(roles.create({ code, name }));
}

async function seedSkills(skills: Repository<SkillEntity>): Promise<void> {
  for (const seed of loadSkillSeeds()) {
    const existing = await skills.findOne({ where: { canonicalName: seed.canonical_name } });
    const payload = {
      canonicalName: seed.canonical_name,
      displayName: seed.display_name,
      category: seed.category ?? null,
      source: seed.source ?? null,
      sourceExternalId: seed.source_external_id ?? null,
      aliases: seed.aliases ?? [],
      inDemand: seed.in_demand ?? false,
    };

    // Idempotent re-seed: leave existing skills untouched (consistent with the role/user
    // seeders and seed.spec). Taxonomy changes are applied via an explicit update, not re-seed.
    if (existing) continue;
    await skills.save(skills.create(payload));
  }
}

function loadSkillSeeds(): SkillSeed[] {
  const filePath = path.join(process.cwd(), 'data', 'skills-pilot.json');
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf-8');
  const json = JSON.parse(raw) as { skills?: SkillSeed[] };
  return json.skills ?? [];
}

async function ensureCredentialsUser(
  repos: SeedRepositories,
  input: { email: string; fullName: string; password: string; avatarUrl?: string | null },
): Promise<UserEntity> {
  const user = await ensureUser(repos.users, input.email, input.fullName, input.avatarUrl ?? null);
  await ensureCredentialsAccount(repos.accounts, user.id, input.email, input.password);
  return user;
}

async function ensureUser(
  users: Repository<UserEntity>,
  emailInput: string,
  fullName: string,
  avatarUrl: string | null,
): Promise<UserEntity> {
  const email = emailInput.trim();
  const emailNormalized = email.toLowerCase();
  let user = await users.findOne({ where: { emailNormalized } });
  if (!user) {
    user = await users.save(
      users.create({
        email,
        emailNormalized,
        fullName,
        avatarUrl,
        status: 'ACTIVE',
        isEmailVerified: true,
        isActive: true,
        lastLoginAt: null,
      }),
    );
  }

  return user;
}

async function ensureCredentialsAccount(
  accounts: Repository<AccountEntity>,
  userId: string,
  emailInput: string,
  password: string,
): Promise<void> {
  const emailNormalized = emailInput.trim().toLowerCase();
  const existingAccount = await accounts.findOne({
    where: { provider: 'CREDENTIALS', providerAccountId: emailNormalized },
  });
  if (!existingAccount) {
    await accounts.save(
      accounts.create({
        userId,
        provider: 'CREDENTIALS',
        providerAccountId: emailNormalized,
        passwordHash: await bcrypt.hash(password, 10),
      }),
    );
  }
}

async function seedMentors(
  repos: SeedRepositories,
  mentorRole: RoleEntity,
  approvedBy: string,
  defaultPassword: string,
): Promise<void> {
  for (const seed of MENTOR_SEEDS) {
    const mentor = seed.hasCredentials
      ? await ensureCredentialsUser(repos, {
          email: seed.email,
          fullName: seed.fullName,
          password: defaultPassword,
          avatarUrl: seed.avatarUrl,
        })
      : await ensureUser(repos.users, seed.email, seed.fullName, seed.avatarUrl);

    await syncMentorSeedUser(repos.users, mentor, seed);
    await ensureUserRole(repos.userRoles, mentor.id, mentorRole.id);
    const profile = await ensureMentorProfile(repos.mentorProfiles, mentor.id, seed, approvedBy);
    await ensureMentorSkills(repos, profile.id, seed.skillCanonicalNames);
  }
}

async function ensureMentorProfile(
  profiles: Repository<MentorProfileEntity>,
  userId: string,
  seed: MentorSeed,
  approvedBy: string,
): Promise<MentorProfileEntity> {
  const existing = await profiles.findOne({ where: [{ userId }, { slug: seed.slug }] });
  const approvedAt = new Date();
  const payload: Partial<MentorProfileEntity> = {
    userId,
    slug: seed.slug,
    status: 'APPROVED',
    headline: seed.headline,
    company: seed.company,
    shortBio: seed.shortBio,
    bio: seed.bio,
    linkedinUrl: seed.linkedinUrl,
    phoneNumber: seed.phoneNumber,
    domainTags: seed.domainTags,
    sessionPriceVnd: seed.sessionPriceVnd,
    sessionDurationMinutes: seed.sessionDurationMinutes,
    currency: 'VND',
    isAcceptingBookings: true,
    ratingAverage: seed.ratingAverage,
    reviewCount: seed.reviewCount,
    completedSessions: seed.completedSessions,
    approvedBy,
    rejectionReason: null,
  };

  if (existing) {
    if (!mentorProfileMatchesSeed(existing, payload)) {
      Object.assign(existing, payload);
      existing.submittedAt = existing.submittedAt ?? approvedAt;
      existing.approvedAt = existing.approvedAt ?? approvedAt;
      return profiles.save(existing);
    }
    return existing;
  }

  return profiles.save(
    profiles.create({
      ...payload,
      submittedAt: approvedAt,
      approvedAt,
    }),
  );
}

async function syncMentorSeedUser(
  users: Repository<UserEntity>,
  user: UserEntity,
  seed: MentorSeed,
): Promise<void> {
  if (user.fullName === seed.fullName && user.avatarUrl === seed.avatarUrl) return;
  user.fullName = seed.fullName;
  user.avatarUrl = seed.avatarUrl;
  await users.save(user);
}

function mentorProfileMatchesSeed(
  profile: MentorProfileEntity,
  payload: Partial<MentorProfileEntity>,
): boolean {
  return Object.entries(payload).every(([key, value]) => {
    const current = profile[key as keyof MentorProfileEntity];
    if (Array.isArray(value)) {
      return (
        Array.isArray(current) &&
        current.length === value.length &&
        current.every((item, index) => item === value[index])
      );
    }
    return current === value;
  });
}

async function ensureMentorSkills(
  repos: SeedRepositories,
  mentorProfileId: string,
  canonicalNames: string[],
): Promise<void> {
  for (const [sortOrder, canonicalName] of canonicalNames.entries()) {
    const skill = await repos.skills.findOne({ where: { canonicalName } });
    if (!skill) throw new Error(`Mentor seed skill not found: ${canonicalName}`);

    const existing = await repos.mentorProfileSkills.findOne({
      where: { mentorProfileId, skillId: skill.id },
    });
    if (existing) continue;
    await repos.mentorProfileSkills.save(
      repos.mentorProfileSkills.create({ mentorProfileId, skillId: skill.id, sortOrder }),
    );
  }
}

async function ensureUserRole(
  userRoles: Repository<UserRoleEntity>,
  userId: string,
  roleId: string,
): Promise<void> {
  const existing = await userRoles.findOne({ where: { userId, roleId } });
  if (existing) return;
  await userRoles.save(userRoles.create({ userId, roleId }));
}

async function run(): Promise<void> {
  await dataSource.initialize();
  try {
    await seedDatabase(dataSource);
    const options = loadSeedOptions();
    console.log('Seed data ready:');
    console.log(`- Admin: ${options.adminEmail}`);
    console.log(`- User: ${options.userEmail}`);
  } finally {
    await dataSource.destroy();
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

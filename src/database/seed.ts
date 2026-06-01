import 'dotenv/config';
import * as bcrypt from 'bcrypt';
import { DataSource, Repository } from 'typeorm';
import dataSource from './data-source';
import { AccountEntity } from './entities/account.entity';
import { RoleCode, RoleEntity } from './entities/role.entity';
import { UserEntity } from './entities/user.entity';
import { UserRoleEntity } from './entities/user-role.entity';

const ROLE_SEEDS: Array<{ code: RoleCode; name: string }> = [
  { code: 'USER', name: 'User' },
  { code: 'ADMIN', name: 'Admin' },
  { code: 'MENTOR', name: 'Mentor' },
  { code: 'BUSINESS', name: 'Business' },
  { code: 'RECRUITER', name: 'Recruiter' },
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
  users: Repository<UserEntity>;
  accounts: Repository<AccountEntity>;
  userRoles: Repository<UserRoleEntity>;
}

export async function seedDatabase(
  source: Pick<DataSource, 'getRepository'>,
  options = loadSeedOptions(),
): Promise<void> {
  const repos: SeedRepositories = {
    roles: source.getRepository(RoleEntity),
    users: source.getRepository(UserEntity),
    accounts: source.getRepository(AccountEntity),
    userRoles: source.getRepository(UserRoleEntity),
  };

  const roles = new Map<RoleCode, RoleEntity>();
  for (const seed of ROLE_SEEDS) {
    roles.set(seed.code, await ensureRole(repos.roles, seed.code, seed.name));
  }

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

async function ensureCredentialsUser(
  repos: SeedRepositories,
  input: { email: string; fullName: string; password: string },
): Promise<UserEntity> {
  const email = input.email.trim();
  const emailNormalized = email.toLowerCase();
  let user = await repos.users.findOne({ where: { emailNormalized } });
  if (!user) {
    user = await repos.users.save(
      repos.users.create({
        email,
        emailNormalized,
        fullName: input.fullName,
        avatarUrl: null,
        status: 'ACTIVE',
        isEmailVerified: true,
        isActive: true,
        lastLoginAt: null,
      }),
    );
  }

  const existingAccount = await repos.accounts.findOne({
    where: { provider: 'CREDENTIALS', providerAccountId: emailNormalized },
  });
  if (!existingAccount) {
    await repos.accounts.save(
      repos.accounts.create({
        userId: user.id,
        provider: 'CREDENTIALS',
        providerAccountId: emailNormalized,
        passwordHash: await bcrypt.hash(input.password, 10),
      }),
    );
  }

  return user;
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

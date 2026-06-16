import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Between,
  FindOptionsWhere,
  ILike,
  In,
  LessThanOrEqual,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';
import { AccountEntity } from '../../database/entities/account.entity';
import { CvMatchEntity } from '../../database/entities/cv-match.entity';
import { CvEntity } from '../../database/entities/cv.entity';
import { InterviewSessionEntity } from '../../database/entities/interview-session.entity';
import { PaymentOrderEntity } from '../../database/entities/payment-order.entity';
import { RoleCode, RoleEntity } from '../../database/entities/role.entity';
import { SessionEntity } from '../../database/entities/session.entity';
import { SkillEntity } from '../../database/entities/skill.entity';
import { UsageEventEntity } from '../../database/entities/usage-event.entity';
import { UserProfileEntity } from '../../database/entities/user-profile.entity';
import { UserRoleEntity } from '../../database/entities/user-role.entity';
import { UserSkillEntity } from '../../database/entities/user-skill.entity';
import { UserSubscriptionEntity } from '../../database/entities/user-subscription.entity';
import { UserEntity } from '../../database/entities/user.entity';
import {
  AdminListUsersQueryDto,
  AdminUserMutableStatus,
  AdminUserStatusFilter,
  AdminUserSummaryQueryDto,
  ReplaceAdminUserRolesDto,
  UpdateAdminUserStatusDto,
} from './dto/admin-users.dto';

type AdminUserListItem = {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  roles: RoleCode[];
  status: AdminUserStatusFilter;
  isEmailVerified: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  cvCount: number;
  matchCount: number;
  interviewCount: number;
  paidAmountVnd: number;
  activePlanCodes: string[];
};

type UserWithOptionalDates = Pick<
  UserEntity,
  | 'id'
  | 'email'
  | 'fullName'
  | 'avatarUrl'
  | 'status'
  | 'isEmailVerified'
  | 'isActive'
  | 'lastLoginAt'
  | 'createdAt'
>;

@Injectable()
export class AdminUsersService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    @InjectRepository(UserProfileEntity)
    private readonly profiles: Repository<UserProfileEntity>,
    @InjectRepository(UserSkillEntity)
    private readonly userSkills: Repository<UserSkillEntity>,
    @InjectRepository(SkillEntity)
    private readonly skills: Repository<SkillEntity>,
    @InjectRepository(RoleEntity)
    private readonly roles: Repository<RoleEntity>,
    @InjectRepository(UserRoleEntity)
    private readonly userRoles: Repository<UserRoleEntity>,
    @InjectRepository(AccountEntity)
    private readonly accounts: Repository<AccountEntity>,
    @InjectRepository(SessionEntity)
    private readonly sessions: Repository<SessionEntity>,
    @InjectRepository(CvEntity)
    private readonly cvs: Repository<CvEntity>,
    @InjectRepository(CvMatchEntity)
    private readonly matches: Repository<CvMatchEntity>,
    @InjectRepository(InterviewSessionEntity)
    private readonly interviews: Repository<InterviewSessionEntity>,
    @InjectRepository(PaymentOrderEntity)
    private readonly orders: Repository<PaymentOrderEntity>,
    @InjectRepository(UserSubscriptionEntity)
    private readonly subscriptions: Repository<UserSubscriptionEntity>,
    @InjectRepository(UsageEventEntity)
    private readonly usageEvents: Repository<UsageEventEntity>,
  ) {}

  async listUsers(query: AdminListUsersQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const roleUserIds = await this.userIdsForRole(query.role);
    if (query.role && !roleUserIds.length) {
      return { items: [], total: 0, page, limit };
    }

    const [items, total] = await this.users.findAndCount({
      where: this.buildUserWhere(query, roleUserIds),
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    const userIds = items.map((user) => user.id);
    const rolesByUserId = await this.rolesByUserId(userIds);
    const mappedItems = await Promise.all(
      items.map((user) => this.toListItem(user, rolesByUserId.get(user.id) ?? [])),
    );

    return {
      items: mappedItems,
      total,
      page,
      limit,
    };
  }

  async getSummary(query: AdminUserSummaryQueryDto) {
    const rangeDays = query.rangeDays ?? 30;
    const from = this.daysAgo(rangeDays);
    const users = await this.users.find({
      where: { createdAt: MoreThanOrEqual(from) as unknown as Date },
      order: { createdAt: 'ASC' },
    });
    const userIds = users.map((user) => user.id);
    const rolesByUserId = await this.rolesByUserId(userIds);
    const statusCounts = users.reduce<Record<AdminUserStatusFilter, number>>(
      (acc, user) => {
        acc[this.deriveStatus(user)] += 1;
        return acc;
      },
      { ACTIVE: 0, UNVERIFIED: 0, SUSPENDED: 0 },
    );
    const roleCounts = this.countRoles(rolesByUserId);
    const [cvCount, matchCount, interviewCount, paidOrders] = await Promise.all([
      this.cvs.count({ where: { createdAt: MoreThanOrEqual(from) as unknown as Date } }),
      this.matches.count({ where: { createdAt: MoreThanOrEqual(from) as unknown as Date } }),
      this.interviews.count({ where: { createdAt: MoreThanOrEqual(from) as unknown as Date } }),
      this.orders.find({
        where: { status: 'PAID', paidAt: MoreThanOrEqual(from) as unknown as Date },
        order: { paidAt: 'ASC' },
      }),
    ]);
    const paidRevenueVnd = paidOrders.reduce((sum, order) => sum + Number(order.amountVnd ?? 0), 0);

    return {
      rangeDays,
      totals: {
        totalUsers: users.length,
        activeUsers: statusCounts.ACTIVE,
        unverifiedUsers: statusCounts.UNVERIFIED,
        suspendedUsers: statusCounts.SUSPENDED,
        newUsers: users.length,
        paidRevenueVnd,
        cvCount,
        matchCount,
        interviewCount,
      },
      roleDistribution: Object.entries(roleCounts).map(([role, count]) => ({ role, count })),
      statusDistribution: Object.entries(statusCounts).map(([status, count]) => ({
        status,
        count,
      })),
      registrationTrend: this.countByDay(users, (user) => user.createdAt),
      activityFunnel: [
        { label: 'Users', value: users.length },
        { label: 'CVs', value: cvCount },
        { label: 'Matches', value: matchCount },
        { label: 'Interviews', value: interviewCount },
      ],
      revenueTrend: this.sumOrdersByPaidDay(paidOrders),
    };
  }

  async getUserDetail(id: string) {
    const user = await this.requireUser(id);
    const [profile, roles, skills, accounts, subscriptions, usageEvents, cvs, interviews, orders] =
      await Promise.all([
        this.profiles.findOne({ where: { userId: id } }),
        this.roleCodes(id),
        this.userSkillSummaries(id),
        this.accounts.find({ where: { userId: id }, order: { createdAt: 'DESC' } }),
        this.subscriptions.find({ where: { userId: id }, order: { createdAt: 'DESC' }, take: 5 }),
        this.usageEvents.find({ where: { userId: id }, order: { usedAt: 'DESC' }, take: 20 }),
        this.cvs.find({ where: { userId: id }, order: { createdAt: 'DESC' }, take: 10 }),
        this.interviews.find({ where: { userId: id }, order: { createdAt: 'DESC' }, take: 10 }),
        this.orders.find({ where: { userId: id }, order: { createdAt: 'DESC' }, take: 10 }),
      ]);
    const cvIds = cvs.map((cv) => cv.id);
    const matchCount = cvIds.length
      ? await this.matches.count({ where: { cvId: In(cvIds) as unknown as string } })
      : 0;
    const paidOrders = orders.filter((order) => order.status === 'PAID');

    return {
      id: user.id,
      email: user.email,
      displayName: user.fullName,
      avatarUrl: user.avatarUrl,
      roles,
      status: this.deriveStatus(user),
      isEmailVerified: user.isEmailVerified,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
      profile,
      skills,
      authProviders: [...new Set(accounts.map((account) => account.provider))],
      subscription: {
        activePlanCodes: subscriptions
          .filter((subscription) => subscription.status === 'ACTIVE')
          .map((subscription) => subscription.planCode),
        recent: subscriptions,
      },
      activityCounts: {
        cvCount: cvs.length,
        matchCount,
        interviewCount: interviews.length,
        paymentCount: paidOrders.length,
        paidAmountVnd: paidOrders.reduce((sum, order) => sum + Number(order.amountVnd ?? 0), 0),
      },
      monthlyActivitySeries: this.monthlyActivitySeries(cvs, interviews, orders),
      usageEvents,
      recentCvs: cvs.map((cv) => ({
        id: cv.id,
        title: cv.title,
        originalFileName: cv.originalFileName,
        targetRole: cv.targetRole,
        createdAt: cv.createdAt,
      })),
      recentInterviews: interviews.map((interview) => ({
        id: interview.id,
        targetRole: interview.targetRole,
        status: interview.status,
        overallScore: interview.overallScore,
        startedAt: interview.startedAt ?? interview.createdAt,
      })),
      recentPayments: orders.map((order) => ({
        id: order.id,
        amountVnd: order.amountVnd,
        status: order.status,
        planCode: order.planCode,
        paidAt: order.paidAt,
        createdAt: order.createdAt,
      })),
    };
  }

  async updateUserStatus(
    actorUserId: string,
    id: string,
    dto: UpdateAdminUserStatusDto,
  ): Promise<AdminUserListItem> {
    const user = await this.requireUser(id);
    const currentRoles = await this.roleCodes(id);
    if (dto.status === 'SUSPENDED' && currentRoles.includes('ADMIN')) {
      await this.assertCanRemoveAdmin(actorUserId, id);
    }

    user.status = dto.status as AdminUserMutableStatus;
    user.isActive = dto.status === 'ACTIVE';
    const saved = await this.users.save(user);

    if (dto.status === 'SUSPENDED') {
      await this.sessions.update({ userId: id } as FindOptionsWhere<SessionEntity>, {
        revokedAt: new Date(),
      });
    }

    return this.toListItem(saved, currentRoles);
  }

  async replaceUserRoles(actorUserId: string, id: string, dto: ReplaceAdminUserRolesDto) {
    const user = await this.requireUser(id);
    const currentRoles = await this.roleCodes(id);
    if (currentRoles.includes('ADMIN') && !dto.roles.includes('ADMIN')) {
      await this.assertCanRemoveAdmin(actorUserId, id);
    }

    const availableRoles = await this.roles.find({
      where: { code: In(dto.roles) as unknown as RoleCode },
    });
    const rolesByCode = new Map(availableRoles.map((role) => [role.code, role]));
    const missing = dto.roles.filter((role) => !rolesByCode.has(role));
    if (missing.length) {
      throw new BadRequestException(`Unknown roles: ${missing.join(', ')}`);
    }

    await this.userRoles.manager.transaction(async () => {
      await this.userRoles.delete({ userId: id });
      await this.userRoles.save(
        dto.roles.map((role) =>
          this.userRoles.create({
            userId: id,
            roleId: rolesByCode.get(role)?.id,
          }),
        ),
      );
    });

    return {
      id: user.id,
      email: user.email,
      displayName: user.fullName,
      roles: dto.roles,
      status: this.deriveStatus(user),
    };
  }

  private buildUserWhere(
    query: AdminListUsersQueryDto,
    userIds?: string[],
  ): FindOptionsWhere<UserEntity>[] | FindOptionsWhere<UserEntity> {
    const base: FindOptionsWhere<UserEntity> = {};
    if (userIds?.length) base.id = In(userIds) as unknown as string;
    if (query.status === 'SUSPENDED') {
      base.status = 'SUSPENDED';
      base.isActive = false;
    } else if (query.status === 'UNVERIFIED') {
      base.status = 'ACTIVE';
      base.isEmailVerified = false;
    } else if (query.status === 'ACTIVE') {
      base.status = 'ACTIVE';
      base.isActive = true;
      base.isEmailVerified = true;
    }

    const createdFrom = this.parseDate(query.createdFrom);
    const createdTo = this.parseDate(query.createdTo, true);
    if (createdFrom && createdTo) base.createdAt = Between(createdFrom, createdTo);
    else if (createdFrom) base.createdAt = MoreThanOrEqual(createdFrom) as unknown as Date;
    else if (createdTo) base.createdAt = LessThanOrEqual(createdTo) as unknown as Date;

    const search = query.search?.trim();
    if (!search) return base;
    return [
      { ...base, email: ILike(`%${search}%`) },
      { ...base, fullName: ILike(`%${search}%`) },
    ];
  }

  private async userIdsForRole(roleCode?: RoleCode): Promise<string[]> {
    if (!roleCode) return [];
    const role = await this.roles.findOne({ where: { code: roleCode } });
    if (!role) return [];
    const assignments = await this.userRoles.find({ where: { roleId: role.id } });
    return [...new Set(assignments.map((assignment) => assignment.userId))];
  }

  private async requireUser(id: string): Promise<UserEntity> {
    const user = await this.users.findOne({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  private async toListItem(
    user: UserWithOptionalDates,
    roles: RoleCode[],
  ): Promise<AdminUserListItem> {
    const cvs = await this.cvs.find({ where: { userId: user.id } });
    const cvIds = cvs.map((cv) => cv.id);
    const [matchCount, interviewCount, paidOrders, activeSubscriptions] = await Promise.all([
      cvIds.length ? this.matches.count({ where: { cvId: In(cvIds) as unknown as string } }) : 0,
      this.interviews.count({ where: { userId: user.id } }),
      this.orders.find({ where: { userId: user.id, status: 'PAID' } }),
      this.subscriptions.find({ where: { userId: user.id, status: 'ACTIVE' } }),
    ]);

    return {
      id: user.id,
      email: user.email,
      displayName: user.fullName,
      avatarUrl: user.avatarUrl,
      roles,
      status: this.deriveStatus(user),
      isEmailVerified: user.isEmailVerified,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
      cvCount: cvs.length,
      matchCount,
      interviewCount,
      paidAmountVnd: paidOrders.reduce((sum, order) => sum + Number(order.amountVnd ?? 0), 0),
      activePlanCodes: [
        ...new Set(activeSubscriptions.map((subscription) => subscription.planCode)),
      ],
    };
  }

  private async rolesByUserId(userIds: string[]): Promise<Map<string, RoleCode[]>> {
    const result = new Map<string, RoleCode[]>();
    if (!userIds.length) return result;
    const userRoles = await this.userRoles.find({
      where: { userId: In(userIds) as unknown as string },
    });
    const roleIds = [...new Set(userRoles.map((userRole) => userRole.roleId))];
    const roles = roleIds.length
      ? await this.roles.find({ where: { id: In(roleIds) as unknown as string } })
      : [];
    const roleById = new Map(
      roles.filter((role) => roleIds.includes(role.id)).map((role) => [role.id, role.code]),
    );

    for (const userRole of userRoles) {
      const role = roleById.get(userRole.roleId);
      if (!role) continue;
      const current = result.get(userRole.userId) ?? [];
      current.push(role);
      result.set(userRole.userId, current);
    }
    return result;
  }

  private async roleCodes(userId: string): Promise<RoleCode[]> {
    const userRoles = await this.userRoles.find({ where: { userId } });
    const roleIds = [...new Set(userRoles.map((userRole) => userRole.roleId))];
    if (!roleIds.length) return [];
    const roles = await this.roles.find({ where: { id: In(roleIds) as unknown as string } });
    return roles.filter((role) => roleIds.includes(role.id)).map((role) => role.code);
  }

  private async userSkillSummaries(userId: string) {
    const userSkills = await this.userSkills.find({ where: { userId }, order: { level: 'DESC' } });
    const skillIds = userSkills.map((userSkill) => userSkill.skillId);
    const skills = skillIds.length
      ? await this.skills.find({ where: { id: In(skillIds) as unknown as string } })
      : [];
    const skillById = new Map(skills.map((skill) => [skill.id, skill]));
    return userSkills.map((userSkill) => {
      const skill = skillById.get(userSkill.skillId);
      return {
        id: userSkill.skillId,
        canonicalName: skill?.canonicalName ?? null,
        displayName: skill?.displayName ?? userSkill.skillId,
        category: skill?.category ?? null,
        level: userSkill.level,
      };
    });
  }

  private async assertCanRemoveAdmin(actorUserId: string, targetUserId: string) {
    if (actorUserId === targetUserId) {
      throw new BadRequestException('Cannot lock out your own admin role');
    }

    const adminRole = await this.roles.findOne({ where: { code: 'ADMIN' } });
    if (!adminRole) throw new BadRequestException('Admin role is not configured');

    const adminAssignments = await this.userRoles.find({ where: { roleId: adminRole.id } });
    const adminUserIds = [...new Set(adminAssignments.map((assignment) => assignment.userId))];
    const activeAdminCount = adminUserIds.length
      ? await this.users.count({
          where: {
            id: In(adminUserIds) as unknown as string,
            status: 'ACTIVE',
            isActive: true,
          },
        })
      : 0;
    if (activeAdminCount <= 1) {
      throw new BadRequestException('Cannot remove or suspend the last active admin');
    }
  }

  private deriveStatus(
    user: Pick<UserEntity, 'status' | 'isActive' | 'isEmailVerified'>,
  ): AdminUserStatusFilter {
    if (!user.isActive || user.status === 'SUSPENDED') return 'SUSPENDED';
    if (!user.isEmailVerified) return 'UNVERIFIED';
    return 'ACTIVE';
  }

  private countRoles(rolesByUserId: Map<string, RoleCode[]>): Partial<Record<RoleCode, number>> {
    const counts: Partial<Record<RoleCode, number>> = {};
    for (const roles of rolesByUserId.values()) {
      for (const role of roles) counts[role] = (counts[role] ?? 0) + 1;
    }
    return counts;
  }

  private countByDay<T>(items: T[], getDate: (item: T) => Date | null | undefined) {
    const counts = new Map<string, number>();
    for (const item of items) {
      const date = this.dayKey(getDate(item));
      if (!date) continue;
      counts.set(date, (counts.get(date) ?? 0) + 1);
    }
    return [...counts.entries()].map(([date, count]) => ({ date, count }));
  }

  private sumOrdersByPaidDay(orders: PaymentOrderEntity[]) {
    const sums = new Map<string, number>();
    for (const order of orders) {
      const date = this.dayKey(order.paidAt ?? order.createdAt);
      if (!date) continue;
      sums.set(date, (sums.get(date) ?? 0) + Number(order.amountVnd ?? 0));
    }
    return [...sums.entries()].map(([date, amountVnd]) => ({ date, amountVnd }));
  }

  private monthlyActivitySeries(
    cvs: CvEntity[],
    interviews: InterviewSessionEntity[],
    orders: PaymentOrderEntity[],
  ) {
    const buckets = new Map<
      string,
      { month: string; cvCount: number; interviewCount: number; paidAmountVnd: number }
    >();
    const ensure = (date: Date | null | undefined) => {
      const month = date ? date.toISOString().slice(0, 7) : 'unknown';
      const bucket = buckets.get(month) ?? {
        month,
        cvCount: 0,
        interviewCount: 0,
        paidAmountVnd: 0,
      };
      buckets.set(month, bucket);
      return bucket;
    };
    cvs.forEach((cv) => {
      ensure(cv.createdAt).cvCount += 1;
    });
    interviews.forEach((interview) => {
      ensure(interview.createdAt).interviewCount += 1;
    });
    orders
      .filter((order) => order.status === 'PAID')
      .forEach((order) => {
        ensure(order.paidAt ?? order.createdAt).paidAmountVnd += Number(order.amountVnd ?? 0);
      });
    return [...buckets.values()].sort((a, b) => a.month.localeCompare(b.month));
  }

  private parseDate(value?: string, endOfDay = false): Date | undefined {
    if (!value) return undefined;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return undefined;
    if (endOfDay) date.setHours(23, 59, 59, 999);
    return date;
  }

  private daysAgo(days: number): Date {
    const date = new Date();
    date.setDate(date.getDate() - days);
    return date;
  }

  private dayKey(value: Date | null | undefined): string | null {
    if (!value) return null;
    return value.toISOString().slice(0, 10);
  }
}

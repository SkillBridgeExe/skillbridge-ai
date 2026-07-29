import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  FindOptionsWhere,
  ILike,
  LessThanOrEqual,
  MoreThan,
  Repository,
} from 'typeorm';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { VoucherRedemptionEntity } from '../../database/entities/voucher-redemption.entity';
import { VoucherEntity } from '../../database/entities/voucher.entity';
import {
  AdminListVouchersQueryDto,
  CreateAdminVoucherDto,
  UpdateAdminVoucherDto,
} from './dto/admin-billing.dto';
import { normalizeVoucherCode } from './voucher-pricing';

type VoucherStatus = 'ACTIVE' | 'UPCOMING' | 'EXPIRED' | 'INACTIVE';
type VoucherUsageStats = {
  redeemedCount: number;
  reservedCount: number;
  reservationHistory: number;
};

const EMPTY_USAGE_STATS: VoucherUsageStats = {
  redeemedCount: 0,
  reservedCount: 0,
  reservationHistory: 0,
};

@Injectable()
export class AdminVoucherService {
  constructor(
    @InjectRepository(VoucherEntity) private readonly vouchers: Repository<VoucherEntity>,
    @InjectRepository(VoucherRedemptionEntity)
    private readonly redemptions: Repository<VoucherRedemptionEntity>,
    private readonly dataSource: DataSource,
  ) {}

  async list(query: AdminListVouchersQueryDto = {}, now = new Date()) {
    await this.redemptions.update(
      { status: 'RESERVED', reservedUntil: LessThanOrEqual(now) },
      { status: 'RELEASED' },
    );
    const page = Math.max(query.page ?? 1, 1);
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const [vouchers, total] = await this.vouchers.findAndCount({
      where: voucherListWhere(query.search, query.status, now),
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    const usageByVoucher = await this.loadUsageStats(
      vouchers.map((voucher) => voucher.id),
      now,
      this.redemptions,
    );
    return {
      page,
      limit,
      total,
      items: vouchers.map((voucher) =>
        this.toAdminDto(voucher, now, usageByVoucher.get(voucher.id)),
      ),
    };
  }

  async create(dto: CreateAdminVoucherDto) {
    const code = normalizeVoucherCode(dto.code);
    if (await this.vouchers.exist({ where: { code } })) {
      throw new BadRequestException('Voucher code already exists');
    }
    assertPeriod(dto.startsAt, dto.endsAt);
    const saved = await this.vouchers.save(
      this.vouchers.create({
        code,
        discountPercent: dto.discountPercent,
        applicablePlanCode: 'PREMIUM',
        startsAt: dto.startsAt,
        endsAt: dto.endsAt,
        maxRedemptions: dto.maxRedemptions,
        perUserLimit: dto.perUserLimit ?? 1,
        isActive: dto.isActive ?? true,
        internalNote: dto.internalNote?.trim() || null,
      }),
    );
    return this.toAdminDto(saved, new Date());
  }

  async update(id: string, dto: UpdateAdminVoucherDto) {
    return this.dataSource.transaction(async (manager) => {
      const vouchers = manager.getRepository(VoucherEntity);
      const redemptions = manager.getRepository(VoucherRedemptionEntity);
      const voucher = await vouchers.findOne({
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!voucher) throw new NotFoundException('Voucher not found');
      const hasUsage = await redemptions.exist({ where: { voucherId: id } });
      if (
        hasUsage &&
        ((dto.code !== undefined && normalizeVoucherCode(dto.code) !== voucher.code) ||
          (dto.discountPercent !== undefined && dto.discountPercent !== voucher.discountPercent))
      ) {
        throw new BadRequestException({
          errorCode: ERROR_CODES.VOUCHER_IMMUTABLE,
          message: 'Voucher code and discount cannot change after first use',
        });
      }
      if (dto.code !== undefined) {
        const code = normalizeVoucherCode(dto.code);
        const duplicate = await vouchers.findOne({ where: { code } });
        if (duplicate && duplicate.id !== id)
          throw new BadRequestException('Voucher code already exists');
        voucher.code = code;
      }
      if (dto.discountPercent !== undefined) voucher.discountPercent = dto.discountPercent;
      if (dto.startsAt !== undefined) voucher.startsAt = dto.startsAt;
      if (dto.endsAt !== undefined) voucher.endsAt = dto.endsAt;
      if (dto.maxRedemptions !== undefined) voucher.maxRedemptions = dto.maxRedemptions;
      if (dto.perUserLimit !== undefined) voucher.perUserLimit = dto.perUserLimit;
      if (dto.isActive !== undefined) voucher.isActive = dto.isActive;
      if (dto.internalNote !== undefined) voucher.internalNote = dto.internalNote?.trim() || null;
      assertPeriod(voucher.startsAt, voucher.endsAt);
      const saved = await vouchers.save(voucher);
      const usage = await this.loadUsageStats([saved.id], new Date(), redemptions);
      return this.toAdminDto(saved, new Date(), usage.get(saved.id));
    });
  }

  private async loadUsageStats(
    voucherIds: string[],
    now: Date,
    redemptions: Repository<VoucherRedemptionEntity>,
  ): Promise<Map<string, VoucherUsageStats>> {
    if (voucherIds.length === 0) return new Map();
    const rows = await redemptions
      .createQueryBuilder('redemption')
      .select('redemption.voucherId', 'voucherId')
      .addSelect('COUNT(*) FILTER (WHERE redemption.status = :redeemedStatus)', 'redeemedCount')
      .addSelect(
        `COUNT(*) FILTER (
          WHERE redemption.status = :reservedStatus
          AND redemption.reservedUntil > :now
        )`,
        'reservedCount',
      )
      .addSelect('COUNT(*)', 'reservationHistory')
      .where('redemption.voucherId IN (:...voucherIds)', { voucherIds })
      .groupBy('redemption.voucherId')
      .setParameters({
        redeemedStatus: 'REDEEMED',
        reservedStatus: 'RESERVED',
        now,
      })
      .getRawMany<{
        voucherId: string;
        redeemedCount: string;
        reservedCount: string;
        reservationHistory: string;
      }>();
    return new Map(
      rows.map((row) => [
        row.voucherId,
        {
          redeemedCount: Number(row.redeemedCount),
          reservedCount: Number(row.reservedCount),
          reservationHistory: Number(row.reservationHistory),
        },
      ]),
    );
  }

  private toAdminDto(
    voucher: VoucherEntity,
    now: Date,
    usage: VoucherUsageStats = EMPTY_USAGE_STATS,
  ) {
    const { redeemedCount, reservedCount, reservationHistory } = usage;
    return {
      id: voucher.id,
      code: voucher.code,
      discountPercent: voucher.discountPercent,
      applicablePlanCode: voucher.applicablePlanCode,
      startsAt: voucher.startsAt.toISOString(),
      endsAt: voucher.endsAt.toISOString(),
      maxRedemptions: voucher.maxRedemptions,
      perUserLimit: voucher.perUserLimit,
      isActive: voucher.isActive,
      internalNote: voucher.internalNote,
      status: voucherStatus(voucher, now),
      redeemedCount,
      reservedCount,
      remainingCount: Math.max(voucher.maxRedemptions - redeemedCount - reservedCount, 0),
      immutable: reservationHistory > 0,
      createdAt: voucher.createdAt?.toISOString?.() ?? null,
      updatedAt: voucher.updatedAt?.toISOString?.() ?? null,
    };
  }
}

function voucherListWhere(
  search: string | undefined,
  status: VoucherStatus | undefined,
  now: Date,
): FindOptionsWhere<VoucherEntity> {
  const where: FindOptionsWhere<VoucherEntity> = {};
  const normalizedSearch = search?.trim().toUpperCase();
  if (normalizedSearch) where.code = ILike(`%${normalizedSearch}%`);
  switch (status) {
    case 'ACTIVE':
      where.isActive = true;
      where.startsAt = LessThanOrEqual(now);
      where.endsAt = MoreThan(now);
      break;
    case 'UPCOMING':
      where.isActive = true;
      where.startsAt = MoreThan(now);
      break;
    case 'EXPIRED':
      where.isActive = true;
      where.endsAt = LessThanOrEqual(now);
      break;
    case 'INACTIVE':
      where.isActive = false;
      break;
  }
  return where;
}

function assertPeriod(startsAt: Date, endsAt: Date): void {
  if (startsAt >= endsAt) throw new BadRequestException('Voucher startsAt must be before endsAt');
}

function voucherStatus(voucher: VoucherEntity, now: Date): VoucherStatus {
  if (!voucher.isActive) return 'INACTIVE';
  if (voucher.startsAt > now) return 'UPCOMING';
  if (voucher.endsAt <= now) return 'EXPIRED';
  return 'ACTIVE';
}

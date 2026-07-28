import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, MoreThan, Repository } from 'typeorm';
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

@Injectable()
export class AdminVoucherService {
  constructor(
    @InjectRepository(VoucherEntity) private readonly vouchers: Repository<VoucherEntity>,
    @InjectRepository(VoucherRedemptionEntity)
    private readonly redemptions: Repository<VoucherRedemptionEntity>,
  ) {}

  async list(query: AdminListVouchersQueryDto = {}, now = new Date()) {
    await this.redemptions.update(
      { status: 'RESERVED', reservedUntil: LessThanOrEqual(now) },
      { status: 'RELEASED' },
    );
    const all = await this.vouchers.find({ order: { createdAt: 'DESC' } });
    const search = query.search?.trim().toUpperCase();
    const filtered = all.filter((voucher) => {
      if (search && !voucher.code.includes(search)) return false;
      return !query.status || voucherStatus(voucher, now) === query.status;
    });
    const page = Math.max(query.page ?? 1, 1);
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const items = await Promise.all(
      filtered
        .slice((page - 1) * limit, page * limit)
        .map((voucher) => this.toAdminDto(voucher, now)),
    );
    return { page, limit, total: filtered.length, items };
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
    const voucher = await this.vouchers.findOne({ where: { id } });
    if (!voucher) throw new NotFoundException('Voucher not found');
    const hasUsage = await this.redemptions.exist({ where: { voucherId: id } });
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
      const duplicate = await this.vouchers.findOne({ where: { code } });
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
    return this.toAdminDto(await this.vouchers.save(voucher), new Date());
  }

  private async toAdminDto(voucher: VoucherEntity, now: Date) {
    const [redeemed, reserved, reservationHistory] = await Promise.all([
      this.redemptions.count({ where: { voucherId: voucher.id, status: 'REDEEMED' } }),
      this.redemptions.count({
        where: { voucherId: voucher.id, status: 'RESERVED', reservedUntil: MoreThan(now) },
      }),
      this.redemptions.count({ where: { voucherId: voucher.id } }),
    ]);
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
      redeemedCount: redeemed,
      reservedCount: reserved,
      remainingCount: Math.max(voucher.maxRedemptions - redeemed - reserved, 0),
      immutable: reservationHistory > 0,
      createdAt: voucher.createdAt?.toISOString?.() ?? null,
      updatedAt: voucher.updatedAt?.toISOString?.() ?? null,
    };
  }
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

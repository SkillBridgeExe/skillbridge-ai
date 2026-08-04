import { BadRequestException } from '@nestjs/common';
import { DataSource, EntityManager, Repository, SelectQueryBuilder } from 'typeorm';
import { VoucherRedemptionEntity } from '../../database/entities/voucher-redemption.entity';
import { VoucherEntity } from '../../database/entities/voucher.entity';
import { AdminVoucherService } from './admin-voucher.service';

function voucher(overrides: Partial<VoucherEntity> = {}): VoucherEntity {
  return {
    id: 'voucher-1',
    code: 'SKILLBRIDGE10',
    benefitType: 'PERCENT_DISCOUNT',
    discountPercent: 10,
    applicablePlanCode: 'PREMIUM',
    creditType: null,
    creditUnits: null,
    startsAt: new Date('2026-07-01T00:00:00.000Z'),
    endsAt: new Date('2026-08-31T00:00:00.000Z'),
    maxRedemptions: 100,
    perUserLimit: 1,
    isActive: true,
    internalNote: null,
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: null,
    ...overrides,
  };
}

function setup() {
  const statsQuery = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    setParameters: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<SelectQueryBuilder<VoucherRedemptionEntity>>;
  const vouchers = {
    find: jest.fn().mockResolvedValue([]),
    findAndCount: jest.fn().mockResolvedValue([[], 0]),
    findOne: jest.fn(),
    exist: jest.fn(),
    create: jest.fn((input) => input),
    save: jest.fn(async (input) => input),
  };
  const redemptions = {
    update: jest.fn().mockResolvedValue({ affected: 0 }),
    count: jest.fn().mockResolvedValue(0),
    exist: jest.fn().mockResolvedValue(false),
    createQueryBuilder: jest.fn().mockReturnValue(statsQuery),
  };
  const manager = {
    getRepository: jest.fn((entity) => {
      if (entity === VoucherEntity) return vouchers;
      if (entity === VoucherRedemptionEntity) return redemptions;
      throw new Error('Unexpected repository');
    }),
  } as unknown as EntityManager;
  const dataSource = {
    transaction: jest.fn(async (work: (manager: EntityManager) => Promise<unknown>) =>
      work(manager),
    ),
  } as unknown as DataSource;
  const service = Reflect.construct(AdminVoucherService, [
    vouchers as unknown as Repository<VoucherEntity>,
    redemptions as unknown as Repository<VoucherRedemptionEntity>,
    dataSource,
  ]) as AdminVoucherService;

  return { service, vouchers, redemptions, statsQuery, dataSource };
}

describe('AdminVoucherService', () => {
  it('paginates vouchers in the database and aggregates usage for the current page', async () => {
    const { service, vouchers, redemptions, statsQuery } = setup();
    vouchers.findAndCount.mockResolvedValue([[voucher()], 1]);
    statsQuery.getRawMany.mockResolvedValue([
      {
        voucherId: 'voucher-1',
        redeemedCount: '5',
        reservedCount: '2',
        reservationHistory: '7',
      },
    ]);

    const result = await service.list(
      { page: 2, limit: 20, search: 'skill', status: 'ACTIVE' },
      new Date('2026-07-29T00:00:00.000Z'),
    );

    expect(vouchers.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 20, take: 20 }),
    );
    expect(vouchers.find).not.toHaveBeenCalled();
    expect(redemptions.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      page: 2,
      limit: 20,
      total: 1,
      items: [
        expect.objectContaining({
          id: 'voucher-1',
          redeemedCount: 5,
          reservedCount: 2,
          remainingCount: 93,
          immutable: true,
        }),
      ],
    });
  });

  it('locks the voucher and rechecks redemption history before immutable fields change', async () => {
    const { service, vouchers, redemptions, dataSource } = setup();
    vouchers.findOne.mockResolvedValue(voucher());
    redemptions.exist.mockResolvedValue(true);

    await expect(service.update('voucher-1', { code: 'NEWCODE' })).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(vouchers.findOne).toHaveBeenCalledWith({
      where: { id: 'voucher-1' },
      lock: { mode: 'pessimistic_write' },
    });
    expect(vouchers.save).not.toHaveBeenCalled();
  });

  it('creates a credit voucher with no Premium discount fields', async () => {
    const { service, vouchers } = setup();
    vouchers.exist.mockResolvedValue(false);

    const result = await service.create({
      code: 'freecv3',
      benefitType: 'CREDIT_GRANT',
      creditType: 'CV_ANALYSIS',
      creditUnits: 3,
      startsAt: new Date('2026-07-01T00:00:00.000Z'),
      endsAt: new Date('2026-08-31T00:00:00.000Z'),
      maxRedemptions: 100,
    });

    expect(result).toEqual(
      expect.objectContaining({
        code: 'FREECV3',
        benefitType: 'CREDIT_GRANT',
        discountPercent: null,
        applicablePlanCode: null,
        creditType: 'CV_ANALYSIS',
        creditUnits: 3,
      }),
    );
  });

  it('does not allow changing a credit reward after the first redemption', async () => {
    const { service, vouchers, redemptions } = setup();
    vouchers.findOne.mockResolvedValue(
      voucher({
        benefitType: 'CREDIT_GRANT',
        discountPercent: null,
        applicablePlanCode: null,
        creditType: 'INTERVIEW_SESSION',
        creditUnits: 1,
      }),
    );
    redemptions.exist.mockResolvedValue(true);

    await expect(service.update('voucher-1', { creditUnits: 2 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(vouchers.save).not.toHaveBeenCalled();
  });
});

import { ConflictException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, LessThanOrEqual } from 'typeorm';
import { CreditUsageReservationEntity } from '../../database/entities/credit-usage-reservation.entity';
import { CreditType } from '../../database/entities/billing-credit-package.entity';
import { UserCreditBalanceEntity } from '../../database/entities/user-credit-balance.entity';

const RESERVATION_TTL_MS = 30 * 60 * 1000;

export interface CreditReservation {
  reservationId: string;
  confirm(source?: { sourceType?: string; sourceId?: string }): Promise<void>;
  refund(): Promise<void>;
}

@Injectable()
export class CreditBalanceService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async list(userId: string): Promise<Array<{ creditType: CreditType; balance: number }>> {
    await this.releaseExpired(userId);
    return this.dataSource.getRepository(UserCreditBalanceEntity).find({ where: { userId } });
  }

  async reserve(userId: string, creditType: CreditType): Promise<CreditReservation | null> {
    const reservation = await this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `credit:${userId}:${creditType}`,
      ]);
      await this.releaseExpiredInTransaction(manager, userId, creditType);
      const balances = manager.getRepository(UserCreditBalanceEntity);
      const current = await balances.findOne({
        where: { userId, creditType },
        lock: { mode: 'pessimistic_write' },
      });
      if (!current || current.balance < 1) return null;
      current.balance -= 1;
      await balances.save(current);
      return manager.getRepository(CreditUsageReservationEntity).save(
        manager.getRepository(CreditUsageReservationEntity).create({
          userId,
          creditType,
          status: 'RESERVED',
          sourceType: null,
          sourceId: null,
          reservedUntil: new Date(Date.now() + RESERVATION_TTL_MS),
        }),
      );
    });
    if (!reservation) return null;
    return {
      reservationId: reservation.id,
      confirm: (source = {}) => this.confirm(reservation.id, source),
      refund: () => this.release(reservation.id),
    };
  }

  async grant(userId: string, creditType: CreditType, units: number): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await this.grantInTransaction(manager, userId, creditType, units);
    });
  }

  async grantInTransaction(
    manager: EntityManager,
    userId: string,
    creditType: CreditType,
    units: number,
  ): Promise<void> {
    await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `credit:${userId}:${creditType}`,
    ]);
    const balances = manager.getRepository(UserCreditBalanceEntity);
    const current = await balances.findOne({
      where: { userId, creditType },
      lock: { mode: 'pessimistic_write' },
    });
    if (current) {
      current.balance += units;
      await balances.save(current);
      return;
    }
    await balances.save(balances.create({ userId, creditType, balance: units }));
  }

  private async confirm(
    id: string,
    source: { sourceType?: string; sourceId?: string },
  ): Promise<void> {
    const result = await this.dataSource.getRepository(CreditUsageReservationEntity).update(
      { id, status: 'RESERVED' },
      {
        status: 'CONSUMED',
        sourceType: source.sourceType ?? null,
        sourceId: source.sourceId ?? null,
      },
    );
    if ((result.affected ?? 0) !== 1) {
      const existing = await this.dataSource
        .getRepository(CreditUsageReservationEntity)
        .findOne({ where: { id } });
      if (existing?.status === 'CONSUMED') return;
      throw new ConflictException('Credit reservation is no longer active');
    }
  }

  private async release(id: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const reservations = manager.getRepository(CreditUsageReservationEntity);
      const reservation = await reservations.findOne({
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!reservation || reservation.status !== 'RESERVED') return;
      reservation.status = 'RELEASED';
      await reservations.save(reservation);
      const balances = manager.getRepository(UserCreditBalanceEntity);
      const balance = await balances.findOne({
        where: { userId: reservation.userId, creditType: reservation.creditType },
        lock: { mode: 'pessimistic_write' },
      });
      if (!balance) return;
      balance.balance += 1;
      await balances.save(balance);
    });
  }

  private async releaseExpired(userId: string): Promise<void> {
    await this.dataSource.transaction((manager) =>
      this.releaseExpiredInTransaction(manager, userId),
    );
  }

  private async releaseExpiredInTransaction(
    manager: EntityManager,
    userId: string,
    creditType?: CreditType,
  ): Promise<void> {
    const reservations = manager.getRepository(CreditUsageReservationEntity);
    const rows = await reservations.find({
      where: {
        userId,
        status: 'RESERVED',
        reservedUntil: LessThanOrEqual(new Date()),
        ...(creditType ? { creditType } : {}),
      },
      lock: { mode: 'pessimistic_write' },
    });
    for (const row of rows) {
      row.status = 'RELEASED';
      await reservations.save(row);
      const balances = manager.getRepository(UserCreditBalanceEntity);
      const balance = await balances.findOne({
        where: { userId, creditType: row.creditType },
        lock: { mode: 'pessimistic_write' },
      });
      if (balance) {
        balance.balance += 1;
        await balances.save(balance);
      }
    }
  }
}

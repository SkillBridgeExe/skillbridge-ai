import { ConflictException } from '@nestjs/common';
import { DataSource, EntityManager, EntityTarget, Repository } from 'typeorm';
import { CreditUsageReservationEntity } from '../../database/entities/credit-usage-reservation.entity';
import { UserCreditBalanceEntity } from '../../database/entities/user-credit-balance.entity';
import { CreditBalanceService } from './credit-balance.service';

type RepoMock<T extends object> = Pick<
  Repository<T>,
  'create' | 'find' | 'findOne' | 'save' | 'update'
> & {
  create: jest.Mock;
  find: jest.Mock;
  findOne: jest.Mock;
  save: jest.Mock;
  update: jest.Mock;
};

function repo<T extends object>(): RepoMock<T> {
  return {
    create: jest.fn((input) => input),
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(),
    save: jest.fn((input) => Promise.resolve(input)),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  } as unknown as RepoMock<T>;
}

describe('CreditBalanceService', () => {
  function setup() {
    const balances = repo<UserCreditBalanceEntity>();
    const reservations = repo<CreditUsageReservationEntity>();
    const repositories = new Map<EntityTarget<unknown>, unknown>([
      [UserCreditBalanceEntity, balances],
      [CreditUsageReservationEntity, reservations],
    ]);
    const manager = {
      getRepository: jest.fn((entity: EntityTarget<unknown>) => repositories.get(entity)),
      query: jest.fn().mockResolvedValue(undefined),
    } as unknown as EntityManager;
    const dataSource = {
      getRepository: jest.fn((entity: EntityTarget<unknown>) => repositories.get(entity)),
      transaction: jest.fn(
        async <T>(work: (entityManager: EntityManager) => Promise<T>): Promise<T> => work(manager),
      ),
    } as unknown as DataSource;
    return {
      service: new CreditBalanceService(dataSource),
      balances,
      reservations,
      manager,
    };
  }

  it('reports a reservation that was released before its value could be confirmed', async () => {
    const { service, balances, reservations } = setup();
    balances.findOne.mockResolvedValue({
      userId: 'user-1',
      creditType: 'CV_ANALYSIS',
      balance: 1,
    });
    reservations.save.mockResolvedValue({
      id: 'reservation-1',
      userId: 'user-1',
      creditType: 'CV_ANALYSIS',
      status: 'RESERVED',
    });
    reservations.update.mockResolvedValue({ affected: 0 });
    reservations.findOne.mockResolvedValue({
      id: 'reservation-1',
      status: 'RELEASED',
    });

    const reservation = await service.reserve('user-1', 'CV_ANALYSIS');

    await expect(
      reservation!.confirm({ sourceType: 'cv', sourceId: '2ef0d936-a6df-499d-805d-e5c09d6c7c47' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('confirms an already consumed reservation idempotently', async () => {
    const { service, balances, reservations } = setup();
    balances.findOne.mockResolvedValue({
      userId: 'user-1',
      creditType: 'CV_ANALYSIS',
      balance: 1,
    });
    reservations.save.mockResolvedValue({
      id: 'reservation-1',
      userId: 'user-1',
      creditType: 'CV_ANALYSIS',
      status: 'RESERVED',
    });
    reservations.update.mockResolvedValue({ affected: 0 });
    reservations.findOne.mockResolvedValue({
      id: 'reservation-1',
      status: 'CONSUMED',
    });

    const reservation = await service.reserve('user-1', 'CV_ANALYSIS');

    await expect(reservation!.confirm({ sourceType: 'cv' })).resolves.toBeUndefined();
  });

  it('refunds a reserved credit at most once', async () => {
    const { service, balances, reservations } = setup();
    const balance = { userId: 'user-1', creditType: 'CV_ANALYSIS', balance: 0 };
    balances.findOne.mockResolvedValueOnce({ ...balance, balance: 1 }).mockResolvedValue(balance);
    reservations.save
      .mockResolvedValueOnce({
        id: 'reservation-1',
        userId: 'user-1',
        creditType: 'CV_ANALYSIS',
        status: 'RESERVED',
      })
      .mockImplementation((input) => Promise.resolve(input));
    reservations.findOne
      .mockResolvedValueOnce({
        id: 'reservation-1',
        userId: 'user-1',
        creditType: 'CV_ANALYSIS',
        status: 'RESERVED',
      })
      .mockResolvedValueOnce({
        id: 'reservation-1',
        userId: 'user-1',
        creditType: 'CV_ANALYSIS',
        status: 'RELEASED',
      });

    const reservation = await service.reserve('user-1', 'CV_ANALYSIS');
    await reservation!.refund();
    await reservation!.refund();

    expect(balance.balance).toBe(1);
  });
});

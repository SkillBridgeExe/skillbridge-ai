import { BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { PaymentWebhookEventEntity } from '../../../database/entities/payment-webhook-event.entity';
import { PaymentProviderRegistry } from '../payment-providers/payment-provider.registry';
import { BillingSettlementService } from './billing-settlement.service';
import { PaymentWebhookService } from './payment-webhook.service';

type WebhookRepoMock = Pick<
  Repository<PaymentWebhookEventEntity>,
  'create' | 'findOne' | 'save'
> & {
  create: jest.Mock;
  findOne: jest.Mock;
  save: jest.Mock;
};

function repo(): WebhookRepoMock {
  return {
    create: jest.fn((input) => input),
    findOne: jest.fn(),
    save: jest.fn((input) => Promise.resolve({ id: 'event-1', ...input })),
  } as unknown as WebhookRepoMock;
}

describe('PaymentWebhookService', () => {
  function setup() {
    const webhookEvents = repo();
    const provider = {
      code: 'PAYOS',
      createPaymentLink: jest.fn(),
      verifyWebhook: jest.fn().mockResolvedValue({
        provider: 'PAYOS',
        orderCode: 123,
        paymentLinkId: 'plink-1',
        reference: 'ref-1',
        status: 'PAID',
        raw: { data: { orderCode: 123 } },
      }),
    };
    const registry = {
      get: jest.fn().mockReturnValue(provider),
    } as unknown as PaymentProviderRegistry;
    const settlement = {
      settlePaidPayment: jest.fn().mockResolvedValue({ processed: true }),
    } as unknown as BillingSettlementService;
    const service = new PaymentWebhookService(
      webhookEvents as unknown as Repository<PaymentWebhookEventEntity>,
      registry,
      settlement,
    );
    return { service, webhookEvents, provider, settlement };
  }

  it('verifies and settles a paid provider webhook once', async () => {
    const { service, webhookEvents, provider, settlement } = setup();
    webhookEvents.findOne.mockResolvedValue(null);

    const result = await service.handleWebhook('payos', {
      success: true,
      signature: 'sig',
      data: { orderCode: 123, paymentLinkId: 'plink-1', reference: 'ref-1' },
    });

    expect(provider.verifyWebhook).toHaveBeenCalled();
    expect(settlement.settlePaidPayment).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'PAYOS', orderCode: 123, status: 'PAID' }),
    );
    expect(result).toEqual({ ok: true, processed: true });
  });

  it('returns duplicate verified webhook status without settling again', async () => {
    const { service, webhookEvents, settlement } = setup();
    webhookEvents.findOne.mockResolvedValue({ verified: true, processed: true });

    const result = await service.handleWebhook('PAYOS', { data: { orderCode: 123 } });

    expect(settlement.settlePaidPayment).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, processed: true });
  });

  it('replays an existing unprocessed webhook through verification and settlement', async () => {
    const { service, webhookEvents, provider, settlement } = setup();
    webhookEvents.findOne.mockResolvedValue({
      verified: true,
      processed: false,
      rawPayload: { data: { orderCode: 123, paymentLinkId: 'plink-1', reference: 'ref-1' } },
    });

    const result = await service.handleWebhook('PAYOS', { data: { orderCode: 123 } });

    expect(provider.verifyWebhook).toHaveBeenCalledWith({
      data: { orderCode: 123, paymentLinkId: 'plink-1', reference: 'ref-1' },
    });
    expect(settlement.settlePaidPayment).toHaveBeenCalled();
    expect(result).toEqual({ ok: true, processed: true });
  });

  it('rejects invalid provider webhook signatures', async () => {
    const { service, webhookEvents, provider } = setup();
    webhookEvents.findOne.mockResolvedValue(null);
    provider.verifyWebhook.mockRejectedValue(new Error('invalid signature'));

    await expect(
      service.handleWebhook('PAYOS', { data: { orderCode: 123 } }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { Repository } from 'typeorm';
import { ERROR_CODES } from '../../../common/constants/error-codes';
import { PaymentWebhookEventEntity } from '../../../database/entities/payment-webhook-event.entity';
import {
  normalizeProvider,
  PaymentProviderRegistry,
} from '../payment-providers/payment-provider.registry';
import { BillingSettlementService } from './billing-settlement.service';

@Injectable()
export class PaymentWebhookService {
  constructor(
    @InjectRepository(PaymentWebhookEventEntity)
    private readonly webhookEvents: Repository<PaymentWebhookEventEntity>,
    private readonly providers: PaymentProviderRegistry,
    private readonly settlement: BillingSettlementService,
  ) {}

  async handleWebhook(
    providerCode: string,
    body: unknown,
  ): Promise<{ ok: true; processed: boolean }> {
    const provider = normalizeProvider(providerCode);
    const eventHash = hashPayload(provider, body);
    const existing = await this.webhookEvents.findOne({ where: { eventHash } });
    if (existing) {
      if (existing.processed) {
        return { ok: true, processed: existing.processed };
      }
      return this.processWebhookEvent(provider, existing, existing.rawPayload);
    }

    const raw = body as {
      signature?: string;
      data?: { orderCode?: number; reference?: string; paymentLinkId?: string };
    };
    const event = await this.webhookEvents.save(
      this.webhookEvents.create({
        provider,
        eventHash,
        rawPayload: body,
        signature: raw.signature ?? null,
        orderCode: raw.data?.orderCode === undefined ? null : String(raw.data.orderCode),
        reference: raw.data?.reference ?? null,
        paymentLinkId: raw.data?.paymentLinkId ?? null,
      }),
    );

    return this.processWebhookEvent(provider, event, body);
  }

  private async processWebhookEvent(
    provider: string,
    event: PaymentWebhookEventEntity,
    payload: unknown,
  ): Promise<{ ok: true; processed: boolean }> {
    try {
      const verified = await this.providers.get(provider).verifyWebhook(payload);
      event.verified = true;
      event.orderCode = String(verified.orderCode);
      event.reference = verified.reference;
      event.paymentLinkId = verified.paymentLinkId;

      event = await this.webhookEvents.save(event);

      if (verified.status === 'PAID') {
        await this.settlement.settlePaidPayment(verified);
      }

      event.processed = true;
      event = await this.webhookEvents.save(event);
      return { ok: true, processed: event.processed };
    } catch (error) {
      event.processingError = error instanceof Error ? error.message : 'Invalid payment webhook';
      await this.webhookEvents.save(event);
      throw new BadRequestException({
        errorCode: ERROR_CODES.PAYMENT_WEBHOOK_INVALID,
        message: 'Invalid payment webhook',
      });
    }
  }
}

function hashPayload(provider: string, payload: unknown): string {
  return createHash('sha256')
    .update(`${provider}:${JSON.stringify(payload)}`)
    .digest('hex');
}

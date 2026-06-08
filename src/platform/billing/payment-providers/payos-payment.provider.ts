import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PayOS, Webhook, WebhookData } from '@payos/node';
import {
  PaymentCheckoutRequest,
  PaymentCheckoutResult,
  PaymentProviderPort,
  VerifiedPaymentStatus,
  VerifiedPaymentWebhook,
} from './payment-provider.port';

@Injectable()
export class PayosPaymentProvider implements PaymentProviderPort {
  readonly code = 'PAYOS';
  private readonly client: PayOS | null;

  constructor(private readonly config: ConfigService) {
    const clientId = config.get<string>('PAYOS_CLIENT_ID') ?? '';
    const apiKey = config.get<string>('PAYOS_API_KEY') ?? '';
    const checksumKey = config.get<string>('PAYOS_CHECKSUM_KEY') ?? '';
    this.client =
      clientId && apiKey && checksumKey
        ? new PayOS({
            clientId,
            apiKey,
            checksumKey,
            partnerCode: config.get<string>('PAYOS_PARTNER_CODE') || undefined,
          })
        : null;
  }

  async createPaymentLink(input: PaymentCheckoutRequest): Promise<PaymentCheckoutResult> {
    const link = await this.requireClient().paymentRequests.create({
      orderCode: input.orderCode,
      amount: input.amountVnd,
      description: input.description,
      returnUrl: this.requiredEnv('PAYOS_RETURN_URL'),
      cancelUrl: this.requiredEnv('PAYOS_CANCEL_URL'),
      items: [{ name: input.itemName.slice(0, 64), quantity: 1, price: input.amountVnd }],
    });

    return {
      checkoutUrl: link.checkoutUrl,
      paymentLinkId: link.paymentLinkId,
      qrCode: link.qrCode,
      providerPayload: link,
      expiresAt: link.expiredAt ? new Date(link.expiredAt * 1000) : null,
    };
  }

  async verifyWebhook(input: unknown): Promise<VerifiedPaymentWebhook> {
    const webhook = input as Webhook;
    const data = await this.requireClient().webhooks.verify(webhook);
    return {
      provider: this.code,
      orderCode: data.orderCode,
      paymentLinkId: data.paymentLinkId ?? null,
      reference: data.reference ?? null,
      status: toVerifiedStatus(webhook, data),
      raw: input,
    };
  }

  private requireClient(): PayOS {
    if (!this.client) {
      throw new ServiceUnavailableException('payOS is not configured');
    }
    return this.client;
  }

  private requiredEnv(key: string): string {
    const value = this.config.get<string>(key) ?? '';
    if (!value) throw new ServiceUnavailableException(`${key} is not configured`);
    return value;
  }
}

function toVerifiedStatus(webhook: Webhook, data: WebhookData): VerifiedPaymentStatus {
  if (webhook.success && data.code === '00') return 'PAID';
  return 'PENDING';
}

import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PayOS, Webhook, WebhookData } from '@payos/node';
import {
  PaymentCheckoutRequest,
  PaymentCheckoutResult,
  PaymentStatusRequest,
  PaymentStatusSnapshot,
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
    const returnBaseUrl = input.checkoutOrigin
      ? buildCheckoutBaseUrl(input.checkoutOrigin)
      : this.requiredEnv('PAYOS_RETURN_URL');
    const cancelBaseUrl = input.checkoutOrigin
      ? buildCheckoutBaseUrl(input.checkoutOrigin)
      : this.requiredEnv('PAYOS_CANCEL_URL');
    const returnUrl = buildOrderCheckoutUrl(returnBaseUrl, input.orderCode);
    const cancelUrl = buildOrderCheckoutUrl(cancelBaseUrl, input.orderCode);
    const link = await this.requireClient().paymentRequests.create({
      orderCode: input.orderCode,
      amount: input.amountVnd,
      description: input.description,
      returnUrl,
      cancelUrl,
      items: [{ name: input.itemName.slice(0, 64), quantity: 1, price: input.amountVnd }],
      expiredAt: Math.floor(input.expiresAt.getTime() / 1000),
    });

    return {
      checkoutUrl: link.checkoutUrl,
      paymentLinkId: link.paymentLinkId,
      qrCode: link.qrCode,
      returnUrl,
      cancelUrl,
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
      amountVnd: data.amount ?? null,
      currency: data.currency ?? null,
      paidAt:
        toVerifiedStatus(webhook, data) === 'PAID'
          ? parsePayosDate(data.transactionDateTime)
          : null,
      raw: input,
    };
  }

  async getPaymentStatus(input: PaymentStatusRequest): Promise<PaymentStatusSnapshot> {
    let link: Awaited<ReturnType<PayOS['paymentRequests']['get']>>;
    try {
      link = await this.requireClient().paymentRequests.get(input.orderCode);
    } catch (error) {
      if (isMissingPayosPayment(error)) {
        return {
          provider: this.code,
          orderCode: input.orderCode,
          paymentLinkId: null,
          reference: null,
          status: 'EXPIRED',
          amountVnd: null,
          currency: 'VND',
          paidAt: null,
          raw: error,
        };
      }
      throw error;
    }
    const linkWithCurrency = link as typeof link & { currency?: string };
    const status = toSnapshotStatus(link.status);
    return {
      provider: this.code,
      orderCode: link.orderCode,
      paymentLinkId: link.id ?? null,
      reference: link.transactions?.[0]?.reference ?? null,
      status,
      amountVnd: link.amount ?? null,
      currency: linkWithCurrency.currency ?? 'VND',
      paidAt:
        status === 'PAID' ? parsePayosDate(link.transactions?.[0]?.transactionDateTime) : null,
      raw: link,
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

export function buildOrderCheckoutUrl(baseUrl: string, orderCode: number): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${orderCode}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function buildCheckoutBaseUrl(origin: string): string {
  return new URL('/billing/checkout', `${origin.replace(/\/+$/, '')}/`).toString();
}

function toVerifiedStatus(webhook: Webhook, data: WebhookData): VerifiedPaymentStatus {
  if (webhook.success && data.code === '00') return 'PAID';
  return 'PENDING';
}

function toSnapshotStatus(status: string): VerifiedPaymentStatus {
  switch (status) {
    case 'PAID':
      return 'PAID';
    case 'CANCELLED':
      return 'CANCELLED';
    case 'EXPIRED':
      return 'EXPIRED';
    case 'FAILED':
      return 'FAILED';
    default:
      return 'PENDING';
  }
}

function parsePayosDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.includes(' ') ? trimmed.replace(' ', 'T') : trimmed;
  const withTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized)
    ? normalized
    : `${normalized}+07:00`;
  const parsed = new Date(withTimezone);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isMissingPayosPayment(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return (error as { code?: unknown }).code === '101';
}

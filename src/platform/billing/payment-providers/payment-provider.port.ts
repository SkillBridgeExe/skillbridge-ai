export const PAYMENT_PROVIDER_PORTS = Symbol('PAYMENT_PROVIDER_PORTS');

export type PaymentProviderCode = string;
export type VerifiedPaymentStatus = 'PAID' | 'PENDING' | 'CANCELLED' | 'EXPIRED' | 'FAILED';

export interface PaymentCheckoutRequest {
  orderCode: number;
  amountVnd: number;
  description: string;
  itemName: string;
}

export interface PaymentCheckoutResult {
  checkoutUrl: string | null;
  paymentLinkId: string | null;
  qrCode: string | null;
  providerPayload: unknown;
  expiresAt: Date | null;
}

export interface PaymentStatusRequest {
  orderCode: number;
}

export interface VerifiedPaymentWebhook {
  provider: PaymentProviderCode;
  orderCode: number;
  paymentLinkId: string | null;
  reference: string | null;
  status: VerifiedPaymentStatus;
  amountVnd: number | null;
  currency: string | null;
  raw: unknown;
}

export type PaymentStatusSnapshot = VerifiedPaymentWebhook;

export interface PaymentProviderPort {
  code: PaymentProviderCode;
  createPaymentLink(input: PaymentCheckoutRequest): Promise<PaymentCheckoutResult>;
  verifyWebhook(input: unknown): Promise<VerifiedPaymentWebhook>;
  getPaymentStatus(input: PaymentStatusRequest): Promise<PaymentStatusSnapshot>;
}

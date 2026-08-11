import { ConfigService } from '@nestjs/config';
import { PayosPaymentProvider } from './payos-payment.provider';

describe('PayosPaymentProvider', () => {
  it('signs return and cancel URLs for the allowed origin that created the order', async () => {
    const provider = new PayosPaymentProvider(
      new ConfigService({
        PAYOS_CLIENT_ID: 'client-id',
        PAYOS_API_KEY: 'api-key',
        PAYOS_CHECKSUM_KEY: 'checksum-key',
        PAYOS_RETURN_URL: 'https://www.skillbridgebuilder.com/billing/checkout',
        PAYOS_CANCEL_URL: 'https://www.skillbridgebuilder.com/billing/checkout',
      }),
    );
    const create = jest.fn().mockResolvedValue({
      checkoutUrl: 'https://pay.payos.vn/web/payment-link-1',
      paymentLinkId: 'payment-link-1',
      qrCode: 'qr-code',
    });
    Object.defineProperty(provider, 'client', {
      value: { paymentRequests: { create } },
    });

    await provider.createPaymentLink({
      orderCode: 1781624341196493,
      amountVnd: 199000,
      description: 'SB1781624341196493',
      itemName: 'Premium',
      expiresAt: new Date('2027-01-15T08:00:00.000Z'),
      checkoutOrigin: 'https://skillbridgebuilder.com',
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        returnUrl: 'https://skillbridgebuilder.com/billing/checkout/1781624341196493',
        cancelUrl: 'https://skillbridgebuilder.com/billing/checkout/1781624341196493',
      }),
    );
  });

  it('uses the order-specific checkout page as the embedded return and cancel URLs', async () => {
    const provider = new PayosPaymentProvider(
      new ConfigService({
        PAYOS_CLIENT_ID: 'client-id',
        PAYOS_API_KEY: 'api-key',
        PAYOS_CHECKSUM_KEY: 'checksum-key',
        PAYOS_RETURN_URL: 'https://skillbridgebuilder.com/billing/checkout/',
        PAYOS_CANCEL_URL: 'https://skillbridgebuilder.com/billing/checkout',
      }),
    );
    const create = jest.fn().mockResolvedValue({
      checkoutUrl: 'https://pay.payos.vn/web/payment-link-1',
      paymentLinkId: 'payment-link-1',
      qrCode: 'qr-code',
      expiredAt: 1_800_000_000,
    });
    Object.defineProperty(provider, 'client', {
      value: { paymentRequests: { create } },
    });

    const result = await provider.createPaymentLink({
      orderCode: 1781624341196493,
      amountVnd: 199000,
      description: 'SB1781624341196493',
      itemName: 'Premium',
      expiresAt: new Date('2027-01-15T08:00:00.000Z'),
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        returnUrl: 'https://skillbridgebuilder.com/billing/checkout/1781624341196493',
        cancelUrl: 'https://skillbridgebuilder.com/billing/checkout/1781624341196493',
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        returnUrl: 'https://skillbridgebuilder.com/billing/checkout/1781624341196493',
        cancelUrl: 'https://skillbridgebuilder.com/billing/checkout/1781624341196493',
      }),
    );
  });

  it('maps the verified webhook transaction time to paidAt', async () => {
    const provider = new PayosPaymentProvider(
      new ConfigService({
        PAYOS_CLIENT_ID: 'client-id',
        PAYOS_API_KEY: 'api-key',
        PAYOS_CHECKSUM_KEY: 'checksum-key',
      }),
    );
    const verify = jest.fn().mockResolvedValue({
      orderCode: 123,
      paymentLinkId: 'plink-123',
      reference: 'ref-123',
      amount: 99000,
      currency: 'VND',
      code: '00',
      transactionDateTime: '2026-08-11 12:34:56',
    });
    Object.defineProperty(provider, 'client', { value: { webhooks: { verify } } });

    const result = await provider.verifyWebhook({ success: true, data: {} });

    expect(result).toEqual(
      expect.objectContaining({
        status: 'PAID',
        paidAt: new Date('2026-08-11T12:34:56+07:00'),
      }),
    );
  });

  it('maps the first successful PayOS transaction time from a paid status response', async () => {
    const provider = new PayosPaymentProvider(
      new ConfigService({
        PAYOS_CLIENT_ID: 'client-id',
        PAYOS_API_KEY: 'api-key',
        PAYOS_CHECKSUM_KEY: 'checksum-key',
      }),
    );
    const get = jest.fn().mockResolvedValue({
      id: 'plink-123',
      orderCode: 123,
      amount: 99000,
      status: 'PAID',
      transactions: [
        {
          reference: 'ref-123',
          amount: 99000,
          transactionDateTime: '2026-08-11 12:34:56',
        },
      ],
    });
    Object.defineProperty(provider, 'client', { value: { paymentRequests: { get } } });

    const result = await provider.getPaymentStatus({ orderCode: 123 });

    expect(result).toEqual(
      expect.objectContaining({
        status: 'PAID',
        paidAt: new Date('2026-08-11T12:34:56+07:00'),
      }),
    );
  });

  it('treats a PayOS missing payment code as an expired local order', async () => {
    const provider = new PayosPaymentProvider(
      new ConfigService({
        PAYOS_CLIENT_ID: 'client-id',
        PAYOS_API_KEY: 'api-key',
        PAYOS_CHECKSUM_KEY: 'checksum-key',
      }),
    );
    const get = jest.fn().mockRejectedValue({
      name: 'APIError',
      status: 200,
      code: '101',
      desc: 'Mã thanh toán không tồn tại',
    });
    Object.defineProperty(provider, 'client', { value: { paymentRequests: { get } } });

    const result = await provider.getPaymentStatus({ orderCode: 123 });

    expect(result).toEqual(
      expect.objectContaining({
        status: 'EXPIRED',
        orderCode: 123,
        currency: 'VND',
      }),
    );
  });
});

import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentProviderRegistry } from './payment-provider.registry';
import { PaymentProviderPort } from './payment-provider.port';

function provider(code: string): PaymentProviderPort {
  return {
    code,
    createPaymentLink: jest.fn(),
    verifyWebhook: jest.fn(),
    getPaymentStatus: jest.fn(),
  };
}

describe('PaymentProviderRegistry', () => {
  it('returns the configured active provider', () => {
    const registry = new PaymentProviderRegistry(
      { get: jest.fn().mockReturnValue('payos') } as unknown as ConfigService,
      [provider('PAYOS')],
    );

    expect(registry.activeProvider().code).toBe('PAYOS');
  });

  it('throws when the provider is not registered', () => {
    const registry = new PaymentProviderRegistry(
      { get: jest.fn().mockReturnValue('VNPAY') } as unknown as ConfigService,
      [provider('PAYOS')],
    );

    expect(() => registry.activeProvider()).toThrow(BadRequestException);
  });
});

import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CheckoutOriginService } from './checkout-origin.service';

describe('CheckoutOriginService', () => {
  function createService() {
    return new CheckoutOriginService(
      new ConfigService({
        PAYOS_CHECKOUT_ALLOWED_ORIGINS:
          'https://skillbridgebuilder.com,https://www.skillbridgebuilder.com',
        PAYOS_RETURN_URL: 'https://www.skillbridgebuilder.com/billing/checkout',
        PAYOS_CANCEL_URL: 'https://www.skillbridgebuilder.com/billing/checkout',
      }),
    );
  }

  it.each(['https://skillbridgebuilder.com', 'https://www.skillbridgebuilder.com'])(
    'accepts the exact configured browser origin %s',
    (origin) => {
      expect(createService().resolve(origin, undefined)).toBe(origin);
    },
  );

  it('uses the referer origin only when the Origin header is absent', () => {
    expect(
      createService().resolve(
        undefined,
        'https://skillbridgebuilder.com/ecosystem/mentor/backend-mentor?slot=1',
      ),
    ).toBe('https://skillbridgebuilder.com');
  });

  it('rejects a browser origin outside the payment allowlist', () => {
    expect(() =>
      createService().resolve(
        'https://attacker.example',
        'https://www.skillbridgebuilder.com/pricing',
      ),
    ).toThrow(BadRequestException);
  });

  it('does not treat legacy return and cancel URL origins as browser allowlist entries', () => {
    const service = new CheckoutOriginService(
      new ConfigService({
        PAYOS_CHECKOUT_ALLOWED_ORIGINS: 'https://skillbridgebuilder.com',
        PAYOS_RETURN_URL: 'https://www.skillbridgebuilder.com/billing/checkout',
        PAYOS_CANCEL_URL: 'https://www.skillbridgebuilder.com/billing/checkout',
      }),
    );

    expect(() => service.resolve('https://www.skillbridgebuilder.com', undefined)).toThrow(
      BadRequestException,
    );
  });

  it('keeps server-internal checkout creation compatible when both headers are absent', () => {
    expect(createService().resolve(undefined, undefined)).toBeUndefined();
  });
});

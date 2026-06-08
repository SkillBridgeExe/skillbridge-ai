import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ERROR_CODES } from '../../../common/constants/error-codes';
import { PAYMENT_PROVIDER_PORTS, PaymentProviderPort } from './payment-provider.port';

@Injectable()
export class PaymentProviderRegistry {
  private readonly providers: Map<string, PaymentProviderPort>;

  constructor(
    private readonly config: ConfigService,
    @Inject(PAYMENT_PROVIDER_PORTS) providers: PaymentProviderPort[],
  ) {
    this.providers = new Map(
      providers.map((provider) => [normalizeProvider(provider.code), provider]),
    );
  }

  activeProviderCode(): string {
    return normalizeProvider(this.config.get<string>('PAYMENT_PROVIDER') ?? 'PAYOS');
  }

  activeProvider(): PaymentProviderPort {
    return this.get(this.activeProviderCode());
  }

  get(providerCode: string): PaymentProviderPort {
    const provider = this.providers.get(normalizeProvider(providerCode));
    if (!provider) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.PAYMENT_PROVIDER_ERROR,
        message: `Unsupported payment provider: ${providerCode}`,
      });
    }
    return provider;
  }
}

export function normalizeProvider(providerCode: string): string {
  return providerCode.trim().toUpperCase();
}

import { BadRequestException } from '@nestjs/common';
import { calculateVoucherPricing, normalizeVoucherCode } from './voucher-pricing';

describe('voucher pricing', () => {
  it('normalizes codes and floors percentage discounts to whole VND', () => {
    expect(normalizeVoucherCode(' skillbridge10 ')).toBe('SKILLBRIDGE10');
    expect(calculateVoucherPricing(199_001, 10)).toEqual({
      originalAmountVnd: 199_001,
      discountPercent: 10,
      discountAmountVnd: 19_900,
      finalAmountVnd: 179_101,
    });
  });

  it.each([0, 100])('rejects an unsupported discount percentage: %s', (percent) => {
    expect(() => calculateVoucherPricing(199_000, percent)).toThrow(BadRequestException);
  });
});

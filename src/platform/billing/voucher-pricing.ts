import { BadRequestException } from '@nestjs/common';
import { ERROR_CODES } from '../../common/constants/error-codes';

export interface VoucherPricing {
  originalAmountVnd: number;
  discountPercent: number;
  discountAmountVnd: number;
  finalAmountVnd: number;
}

export function normalizeVoucherCode(value: string): string {
  return value.trim().toUpperCase();
}

export function calculateVoucherPricing(
  originalAmountVnd: number,
  discountPercent: number,
): VoucherPricing {
  if (!Number.isInteger(discountPercent) || discountPercent < 1 || discountPercent > 99) {
    throw new BadRequestException({
      errorCode: ERROR_CODES.VOUCHER_INVALID,
      message: 'Voucher discount percent must be between 1 and 99',
    });
  }
  const discountAmountVnd = Math.floor((originalAmountVnd * discountPercent) / 100);
  return {
    originalAmountVnd,
    discountPercent,
    discountAmountVnd,
    finalAmountVnd: originalAmountVnd - discountAmountVnd,
  };
}

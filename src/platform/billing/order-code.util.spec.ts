import { generatePayosOrderCode } from './order-code.util';

describe('generatePayosOrderCode', () => {
  it('generates a safe integer order code', () => {
    const code = generatePayosOrderCode();
    expect(Number.isSafeInteger(code)).toBe(true);
    expect(code).toBeGreaterThan(0);
  });
});

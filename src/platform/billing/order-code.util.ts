export function generatePayosOrderCode(): number {
  const suffix = Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, '0');
  const code = Number(`${Date.now()}${suffix}`);
  if (!Number.isSafeInteger(code)) {
    throw new Error('Generated payOS orderCode is outside the safe integer range');
  }
  return code;
}

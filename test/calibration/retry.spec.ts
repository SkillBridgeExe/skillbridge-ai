import { withRetry } from '../../src/calibration/retry';

describe('withRetry', () => {
  it('returns on first success without retrying', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    await expect(withRetry(fn, 2)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on throw then succeeds; calls onRetry per retry', async () => {
    const fn = jest.fn().mockRejectedValueOnce(new Error('transient')).mockResolvedValue('ok');
    const onRetry = jest.fn();
    await expect(withRetry(fn, 2, onRetry)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 1);
  });

  it('throws the LAST error after exhausting all retries', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('boom'));
    await expect(withRetry(fn, 2)).rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });
});

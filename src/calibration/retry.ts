/**
 * Retry an async fn on throw — for TRANSIENT failures (e.g. an LLM occasionally returning
 * malformed JSON that the strict parser rejects). Tries once, then up to `retries` more times;
 * calls `onRetry(err, attemptNo)` before each retry. Re-throws the LAST error if all attempts fail.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  retries: number,
  onRetry?: (err: unknown, attempt: number) => void,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) onRetry?.(err, attempt + 1);
    }
  }
  throw lastErr;
}

/** Any prompt-injection-shaped phrase an external source (GitHub description, page title) could
 *  carry, so a tool result can never redirect the model. Primary control is the prompt telling the
 *  model untrusted_data is DATA, not instructions (Task 10/11 prompt diff); this is the deterministic
 *  backstop (mirrors stripRawUrls' role in diagnosis-grounding.ts / chat-grounding.ts). */
const INSTRUCTION_LIKE =
  /\b(?:ignore|disregard)\s+(?:all|any|the|previous)(?:\s+(?:all|any|the|previous))*\s+instructions?\b|\bsystem prompt\b|\byou are now\b|\bnew instructions?:/gi;

/** Wrap a tool's result under an explicit "untrusted" marker key, with any instruction-like phrase
 *  in the (stringified) payload redacted first. */
export function sanitizeUntrustedFacts<T>(result: T): { untrusted_data: T } {
  const stripped = JSON.parse(JSON.stringify(result).replace(INSTRUCTION_LIKE, '[redacted]')) as T;
  return { untrusted_data: stripped };
}

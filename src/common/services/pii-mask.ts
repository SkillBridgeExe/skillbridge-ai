/**
 * Shared PII masking for anything persisted to the audit trail (ai_requests/ai_results).
 * cv-review already redacts its trace; cv-jd-match + interview persisted raw LLM output and
 * per-skill `evidence_text` (verbatim CV quotes that routinely carry email/phone) unredacted.
 * This brings them to the same masking level. Emails + phones only — date ranges / scores are
 * untouched (no broad number masking), matching cv-review's behaviour.
 */

/** Mask emails in an arbitrary string. */
export function maskEmails(text: string): string {
  return text.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[redacted-email]');
}

/** Mask VN / international phone numbers in an arbitrary string. */
export function maskPhones(text: string): string {
  return text.replace(/(?:\+?84|0)[\s.\-]?\d(?:[\s.\-]?\d){7,9}/g, '[redacted-phone]');
}

/** Mask all PII (emails + phones) in a string. */
export function maskPii(text: string): string {
  return maskPhones(maskEmails(text));
}

/**
 * Deep-mask every string in a JSON-serialisable value (objects/arrays/strings), returning a
 * structurally-identical clone with emails + phones masked. Use to scrub a parsed_response
 * before persisting it while keeping its shape intact for downstream readers (e.g. gap report).
 */
export function maskPiiDeep<T>(value: T): T {
  if (value == null) return value;
  return JSON.parse(maskPii(JSON.stringify(value))) as T;
}

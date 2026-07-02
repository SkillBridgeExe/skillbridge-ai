import { createHash } from 'crypto';

/**
 * Identity hash for a JD's CONTENT (not its row): survives copy-paste whitespace/case noise so
 * two matches of the same pasted JD share lineage. Used by getProgress prior-match lookup.
 */
export function jdContentHash(rawText: string): string {
  const normalized = rawText.trim().replace(/\s+/g, ' ').toLowerCase();
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

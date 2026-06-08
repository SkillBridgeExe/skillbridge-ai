/**
 * Slot for a future layout-aware extractor (LiteParse / opendataloader) that would fix
 * 2-column reading order — what unpdf does NOT do. Wire when/if adopted (see thamkhao D.1).
 */
export async function liteParseExtract(_buffer: Buffer): Promise<string> {
  throw new Error('LiteParse adapter not wired — reading-order slot for a future A/B.');
}

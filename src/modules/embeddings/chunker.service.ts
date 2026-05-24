import { Injectable } from '@nestjs/common';

export interface Chunk {
  index: number;
  content: string;
  tokenCount: number;
}

/**
 * Simple character/word-based text chunker.
 *
 * Default: ~500 tokens per chunk, ~50 token overlap.
 * Token estimate: 1 token ~ 4 chars (English). Vietnamese is roughly similar.
 *
 * For production, swap for a tokenizer-aware splitter (e.g. tiktoken).
 */
@Injectable()
export class ChunkerService {
  private readonly charsPerChunk = 2000; // ~500 tokens
  private readonly charOverlap = 200; // ~50 tokens

  chunk(text: string): Chunk[] {
    const normalised = text.replace(/\r\n/g, '\n').trim();
    if (!normalised) return [];

    const chunks: Chunk[] = [];
    let start = 0;
    let index = 0;

    while (start < normalised.length) {
      const end = Math.min(start + this.charsPerChunk, normalised.length);
      const slice = normalised.slice(start, end);
      chunks.push({
        index,
        content: slice,
        tokenCount: Math.ceil(slice.length / 4),
      });
      if (end === normalised.length) break;
      start = end - this.charOverlap;
      index += 1;
    }

    return chunks;
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkillTextScannerService } from './skill-text-scanner.service';
import { TextMetrics } from './text-metrics';

/**
 * Scanned-PDF OCR fallback (input-quality lane). When a PDF's text layer is too thin to read
 * (scanned / image-only CV), {@link ScannedPdfOcrService.rescue} rasterizes the first N pages
 * with mupdf, OCRs them with the existing Tesseract engine, and returns the OCR text ONLY when
 * deterministic metrics say it is genuinely better than the original.
 *
 * Design invariants (see docs spec 2026-06-14-scanned-pdf-ocr-fallback):
 *  - rescue() NEVER throws — every failure path returns { text: original, ocrUsed: false, reason }.
 *  - rescue() OWNS the Tesseract worker + the mupdf doc and frees both in a single finally on
 *    EVERY path including timeout (terminate() is the only thing that interrupts a stuck recognize).
 *  - Reuses computeTextMetrics + the shared SkillTextScannerService so skillsFound is comparable
 *    to the eval harness and the live extraction_quality signal.
 *  - Additive only: does not touch scoring / gap / rewrite / cv-parse.
 */

export type OcrRescueReason =
  | 'disabled'
  | 'oversized'
  | 'render_failed'
  | 'ocr_failed'
  | 'timeout'
  | 'empty_render'
  | 'ocr_not_better';

export interface OcrRescueMeta {
  /** whether OCR was actually attempted (false for disabled). */
  attempted: boolean;
  pagesRendered: number;
  renderMs: number;
  ocrMs: number;
  /** metrics of the original (pdf-parse) text — PII-safe (counts/ratios/canonicals only). */
  original: TextMetrics;
  /** metrics of the OCR text, when OCR ran. */
  ocr?: TextMetrics;
  decision: 'kept_original' | 'used_ocr';
  reason?: OcrRescueReason;
}

export interface ScannedPdfOcrResult {
  /** chosen text: OCR when better, else the original. */
  text: string;
  /** true iff OCR text was selected. */
  ocrUsed: boolean;
  metadata: OcrRescueMeta;
}

interface OcrFallbackConfig {
  enabled: boolean;
  maxPages: number;
  timeoutMs: number;
  maxPdfBytes: number;
  dpi: number;
}

@Injectable()
export class ScannedPdfOcrService {
  private readonly logger = new Logger(ScannedPdfOcrService.name);
  private readonly cfg: OcrFallbackConfig;

  constructor(
    config: ConfigService,
    private readonly scanner: SkillTextScannerService,
  ) {
    // Computed in the constructor body (NOT a field initializer) so the `config` parameter is
    // assigned before use regardless of useDefineForClassFields. Joi already defaulted these.
    this.cfg = {
      enabled: config.get<boolean>('ocrFallback.enabled') ?? true,
      maxPages: config.get<number>('ocrFallback.maxPages') ?? 3,
      timeoutMs: config.get<number>('ocrFallback.timeoutMs') ?? 25000,
      maxPdfBytes: config.get<number>('ocrFallback.maxPdfBytes') ?? 10485760,
      dpi: config.get<number>('ocrFallback.dpi') ?? 200,
    };
  }

  /** test-only view of the resolved config. */
  get cfgForTest(): OcrFallbackConfig {
    return this.cfg;
  }

  /**
   * Deterministic "don't pick OCR if it is worse" rule. Picks OCR iff ALL conditions hold.
   * Rule 3 (relative word-likeness) is SKIPPED when the original is thin — a near-empty scan can
   * show a misleadingly-high wordlikeRatio from sparse PDF metadata, which would wrongly reject
   * good OCR; we then rely on the absolute floor in rule 2.
   */
  private decide(O: TextMetrics, R: TextMetrics): { useOcr: boolean; reason?: OcrRescueReason } {
    const rule1 = R.charCount >= Math.max(200, O.charCount * 1.5);
    const rule2 = R.wordlikeRatio >= 0.6;
    const originalSubstantial = O.charCount >= 300 || O.wordCount >= 50;
    const rule3 = !originalSubstantial || R.wordlikeRatio >= O.wordlikeRatio - 0.05;
    const rule4 = R.mojibakeRatio <= O.mojibakeRatio + 0.01;
    const rule5 = R.skillsFound >= O.skillsFound;
    const useOcr = rule1 && rule2 && rule3 && rule4 && rule5;
    return useOcr ? { useOcr: true } : { useOcr: false, reason: 'ocr_not_better' };
  }

  /** test-only passthrough to the pure decision rule. */
  decideForTest(O: TextMetrics, R: TextMetrics): { useOcr: boolean; reason?: OcrRescueReason } {
    return this.decide(O, R);
  }
}

import { mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Tesseract from 'tesseract.js';
import { SkillTextScannerService } from './skill-text-scanner.service';
import { computeTextMetrics, TextMetrics } from './text-metrics';

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

  // ---- OCR rescue pipeline ----

  private mupdfMod: unknown;

  private async loadMupdf(): Promise<any> {
    if (!this.mupdfMod) {
      // mupdf is ESM + top-level-await. require() AND a downleveled `await import` both throw
      // ERR_REQUIRE_ASYNC_MODULE under module:"commonjs". This indirect import is NOT rewritten
      // by tsc, so native dynamic import() loads the ESM module at runtime. (proven by spike)
      const dynImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;
      this.mupdfMod = await dynImport('mupdf');
    }
    return this.mupdfMod;
  }

  /** Rasterize up to maxPages pages to PNG buffers. Frees native memory even on error. */
  protected async renderPages(buffer: Buffer, maxPages: number, dpi: number): Promise<Buffer[]> {
    const mupdf = await this.loadMupdf();
    const doc = mupdf.Document.openDocument(new Uint8Array(buffer), 'application/pdf');
    const out: Buffer[] = [];
    try {
      const n = Math.min(doc.countPages(), maxPages);
      for (let i = 0; i < n; i++) {
        const page = doc.loadPage(i);
        const pix = page.toPixmap(
          mupdf.Matrix.scale(dpi / 72, dpi / 72),
          mupdf.ColorSpace.DeviceRGB,
          false,
        );
        out.push(Buffer.from(pix.asPNG()));
        pix.destroy?.();
        page.destroy?.();
      }
    } finally {
      doc.destroy?.();
    }
    return out;
  }

  /** OCR each PNG with the GIVEN worker. Does NOT own/terminate the worker (rescue does). */
  protected async ocrPages(worker: any, pngs: Buffer[]): Promise<string> {
    const parts: string[] = [];
    for (const png of pngs) {
      const res = await worker.recognize(png);
      parts.push(res.data.text);
    }
    return parts.join('\n');
  }

  /** Create a Tesseract worker for eng+vie. Overridable seam for tests. */
  protected async createWorker(): Promise<any> {
    // Cache eng+vie traineddata under the OS temp dir (writable on Cloud Run = /tmp) instead of the
    // default cwd, so a run never dumps ~tens of MB of *.traineddata into the project / app root.
    const cachePath = join(tmpdir(), 'skillbridge-tesseract');
    mkdirSync(cachePath, { recursive: true });
    return Tesseract.createWorker('eng+vie', undefined, { cachePath });
  }

  /**
   * Rescue a thin/scanned PDF via OCR. NEVER throws: any failure returns the original text with
   * ocrUsed=false + a reason. rescue() OWNS the worker and frees it in a single finally on EVERY
   * path (terminate() is the only thing that interrupts a stuck recognize). If the timeout fires
   * during the render phase (before the worker exists), the background task terminates the worker
   * it later creates, so nothing leaks.
   */
  async rescue(buffer: Buffer, originalText: string): Promise<ScannedPdfOcrResult> {
    const scan = (t: string) => this.scanner.scan(t);
    const original = computeTextMetrics(originalText, scan);
    const keep = (
      reason: OcrRescueReason,
      attempted = true,
      extra: Partial<OcrRescueMeta> = {},
    ): ScannedPdfOcrResult => ({
      text: originalText,
      ocrUsed: false,
      metadata: {
        attempted,
        pagesRendered: 0,
        renderMs: 0,
        ocrMs: 0,
        original,
        decision: 'kept_original',
        reason,
        ...extra,
      },
    });

    if (!this.cfg.enabled) return keep('disabled', false);
    if (buffer.length > this.cfg.maxPdfBytes) return keep('oversized');

    let worker: any;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ timedOut: true }>((res) => {
      timer = setTimeout(() => res({ timedOut: true }), this.cfg.timeoutMs);
    });
    const work = (async () => {
      const t0 = Date.now();
      const pngs = await this.renderPages(buffer, this.cfg.maxPages, this.cfg.dpi);
      const renderMs = Date.now() - t0;
      if (pngs.length === 0) return { empty: true as const, renderMs };
      worker = await this.createWorker();
      if (finished) {
        // Race already lost during createWorker — terminate the worker we just made (no leak).
        await worker.terminate?.().catch(() => undefined);
        return { aborted: true as const };
      }
      const t1 = Date.now();
      const ocrText = await this.ocrPages(worker, pngs);
      return {
        empty: false as const,
        pages: pngs.length,
        renderMs,
        ocrMs: Date.now() - t1,
        ocrText,
      };
    })();

    try {
      const res = await Promise.race([work, timeout]);
      if ('timedOut' in res) return keep('timeout');
      if ('aborted' in res) return keep('timeout');
      if (res.empty) return keep('empty_render', true, { renderMs: res.renderMs });
      const ocr = computeTextMetrics(res.ocrText, scan);
      const d = this.decide(original, ocr);
      const base = {
        attempted: true,
        pagesRendered: res.pages,
        renderMs: res.renderMs,
        ocrMs: res.ocrMs,
        original,
        ocr,
      };
      return d.useOcr
        ? { text: res.ocrText, ocrUsed: true, metadata: { ...base, decision: 'used_ocr' } }
        : {
            text: originalText,
            ocrUsed: false,
            metadata: { ...base, decision: 'kept_original', reason: d.reason },
          };
    } catch (e) {
      this.logger.warn(`OCR rescue failed: ${e instanceof Error ? e.message : String(e)}`);
      return keep(worker ? 'ocr_failed' : 'render_failed');
    } finally {
      finished = true;
      if (timer) clearTimeout(timer);
      if (worker) await worker.terminate?.().catch(() => undefined);
    }
  }
}

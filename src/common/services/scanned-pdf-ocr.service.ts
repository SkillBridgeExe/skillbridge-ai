import { mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Worker } from 'worker_threads';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkillTextScannerService } from './skill-text-scanner.service';
import { computeTextMetrics, TextMetrics } from './text-metrics';
import type { OcrWorkerInput, OcrWorkerResult } from './ocr-worker';

/**
 * Scanned-PDF OCR fallback (input-quality lane). When a PDF's text layer is too thin to read
 * (scanned / image-only CV), {@link ScannedPdfOcrService.rescue} rasterizes the first N pages and
 * OCRs them, returning the OCR text ONLY when deterministic metrics say it is genuinely better.
 *
 * Execution model: the heavy, blocking work (pdfium WASM render + Tesseract OCR) runs in a
 * worker_thread (see ocr-worker.ts). This keeps the main event loop responsive (so the timeout
 * actually fires) AND lets us hard-terminate the whole thread on timeout — the only reliable way to
 * interrupt a stuck Tesseract load or slow WASM render, with no worker/native-memory leak.
 *
 * Rasterizer stack is fully permissive + native-free: @hyzyla/pdfium (WASM, MIT/BSD) + pngjs
 * (pure JS, MIT) + tesseract.js (WASM). No AGPL, no prebuilt native binaries (alpine-safe).
 *
 * Invariants:
 *  - rescue() NEVER throws — every failure path returns { text: original, ocrUsed: false, reason }.
 *  - The worker is terminated in a single finally on EVERY path (success/timeout/error).
 *  - Reuses computeTextMetrics + the shared SkillTextScannerService so skillsFound is comparable to
 *    the eval harness and the live extraction_quality signal.
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
  /** set only when the primary attempt timed out and a lower-DPI retry ran. */
  retried?: boolean;
  /** DPI of the attempt that produced this outcome; set only on the retry path. */
  dpiUsed?: number;
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
  /** lower DPI for the single timeout retry; 0 disables the retry. */
  retryDpi: number;
}

/** A running OCR job: a result promise plus a hard-terminate handle. The seam for unit tests. */
interface OcrRun {
  result: Promise<{ text: string; pages: number; renderMs: number; ocrMs: number }>;
  terminate: () => Promise<void>;
}

const TIMEOUT = Symbol('ocr-timeout');

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
      retryDpi: config.get<number>('ocrFallback.retryDpi') ?? 120,
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

  /**
   * Spawn the render+OCR worker_thread and return its result promise + a hard-terminate handle.
   * Overridable seam: unit tests subclass this to inject results with no real thread/WASM/network.
   */
  protected runOcr(buffer: Buffer, maxPages: number, dpi: number): OcrRun {
    const cachePath = join(tmpdir(), 'skillbridge-tesseract');
    mkdirSync(cachePath, { recursive: true });

    // __filename is *.ts under ts-node (dev/eval) and *.js under the compiled build (prod).
    const isTs = __filename.endsWith('.ts');
    const workerFile = join(__dirname, isTs ? 'ocr-worker.ts' : 'ocr-worker.js');
    const execArgv = isTs ? ['-r', 'ts-node/register/transpile-only'] : [];
    const workerData: OcrWorkerInput = { pdf: buffer, maxPages, dpi, cachePath };
    const worker = new Worker(workerFile, { workerData, execArgv });

    const result = new Promise<{ text: string; pages: number; renderMs: number; ocrMs: number }>(
      (resolve, reject) => {
        worker.once('message', (m: OcrWorkerResult) => {
          if (m.ok) resolve({ text: m.text, pages: m.pages, renderMs: m.renderMs, ocrMs: m.ocrMs });
          else reject(Object.assign(new Error(m.message), { stage: m.stage }));
        });
        worker.once('error', reject);
        worker.once('exit', (code) => {
          if (code !== 0) reject(new Error(`OCR worker exited (${code})`));
        });
      },
    );
    return { result, terminate: () => worker.terminate().then(() => undefined) };
  }

  /**
   * Rescue a thin/scanned PDF via OCR. NEVER throws: any failure returns the original text with
   * ocrUsed=false + a reason. The worker is hard-terminated in a single finally on EVERY path
   * (success/timeout/error) — terminating the thread kills the render + the nested Tesseract worker
   * with no leak, and because the heavy work is off the main loop the timeout actually fires.
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

    let attempt = await this.attemptOcr(buffer, this.cfg.dpi);
    // Timeout-only retry: a dense scan that blows the budget at full DPI usually fits at a lower
    // one (~(retryDpi/dpi)² of the pixels). Errors do NOT retry — same input, same failure.
    let retryMeta: Pick<OcrRescueMeta, 'retried' | 'dpiUsed'> = {};
    if (attempt.kind === 'timeout' && this.cfg.retryDpi > 0 && this.cfg.retryDpi < this.cfg.dpi) {
      this.logger.warn(
        `OCR timed out at ${this.cfg.dpi} DPI after ${this.cfg.timeoutMs}ms; retrying once at ${this.cfg.retryDpi} DPI.`,
      );
      retryMeta = { retried: true, dpiUsed: this.cfg.retryDpi };
      attempt = await this.attemptOcr(buffer, this.cfg.retryDpi);
    }

    if (attempt.kind === 'timeout') return keep('timeout', true, retryMeta);
    if (attempt.kind === 'err') {
      this.logger.warn(`OCR rescue failed (${attempt.stage ?? 'unknown'}): ${attempt.message}`);
      return keep(attempt.stage === 'ocr' ? 'ocr_failed' : 'render_failed', true, retryMeta);
    }

    const { text, pages, renderMs, ocrMs } = attempt;
    if (!text || text.trim().length === 0) {
      return keep('empty_render', true, { pagesRendered: pages, renderMs, ocrMs, ...retryMeta });
    }
    const ocr = computeTextMetrics(text, scan);
    const d = this.decide(original, ocr);
    const base = {
      attempted: true,
      pagesRendered: pages,
      renderMs,
      ocrMs,
      original,
      ocr,
      ...retryMeta,
    };
    return d.useOcr
      ? { text, ocrUsed: true, metadata: { ...base, decision: 'used_ocr' } }
      : {
          text: originalText,
          ocrUsed: false,
          metadata: { ...base, decision: 'kept_original', reason: d.reason },
        };
  }

  /**
   * One render+OCR attempt at the given DPI, raced against the timeout budget. Never throws;
   * the worker is hard-terminated in the finally on every path (success/timeout/error).
   */
  private async attemptOcr(
    buffer: Buffer,
    dpi: number,
  ): Promise<
    | { kind: 'ok'; text: string; pages: number; renderMs: number; ocrMs: number }
    | { kind: 'timeout' }
    | { kind: 'err'; stage?: string; message: string }
  > {
    const run = this.runOcr(buffer, this.cfg.maxPages, dpi);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof TIMEOUT>((res) => {
      timer = setTimeout(() => res(TIMEOUT), this.cfg.timeoutMs);
    });
    try {
      const raced = await Promise.race([run.result, timeout]);
      if (raced === TIMEOUT) return { kind: 'timeout' };
      return { kind: 'ok', ...raced };
    } catch (e) {
      return {
        kind: 'err',
        stage: (e as { stage?: string }).stage,
        message: e instanceof Error ? e.message : String(e),
      };
    } finally {
      if (timer) clearTimeout(timer);
      await run.terminate().catch(() => undefined); // hard-kill the thread on every path
    }
  }
}

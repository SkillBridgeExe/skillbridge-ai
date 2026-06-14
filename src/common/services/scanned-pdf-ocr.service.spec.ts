import { ConfigService } from '@nestjs/config';
import { ScannedPdfOcrService } from './scanned-pdf-ocr.service';
import { TextMetrics } from './text-metrics';

/** Stub ConfigService backed by a plain map (dot-path keys, e.g. 'ocrFallback.maxPages'). */
const cfg = (over: Record<string, unknown> = {}): ConfigService =>
  ({ get: (k: string) => over[k] }) as unknown as ConfigService;

type ScannerLike = import('./skill-text-scanner.service').SkillTextScannerService;
const scanner = { scan: () => [] } as unknown as ScannerLike;

/** Build a TextMetrics with sane zero defaults; override only the fields a test cares about. */
const M = (o: Partial<TextMetrics>): TextMetrics => ({
  charCount: 0,
  lineCount: 0,
  wordCount: 0,
  nonWsRatio: 0,
  mojibakeCount: 0,
  mojibakeRatio: 0,
  wordlikeRatio: 0,
  skillsFound: 0,
  skillCanonicals: [],
  ...o,
});

const svc = (over: Record<string, unknown> = {}) => new ScannedPdfOcrService(cfg(over), scanner);

describe('ScannedPdfOcrService — config', () => {
  it('uses safe defaults when env is unset', () => {
    expect(svc().cfgForTest).toEqual({
      enabled: true,
      maxPages: 3,
      timeoutMs: 25000,
      maxPdfBytes: 10485760,
      dpi: 200,
    });
  });

  it('honours overrides', () => {
    const s = svc({
      'ocrFallback.enabled': false,
      'ocrFallback.maxPages': 5,
      'ocrFallback.dpi': 150,
    });
    expect(s.cfgForTest.enabled).toBe(false);
    expect(s.cfgForTest.maxPages).toBe(5);
    expect(s.cfgForTest.dpi).toBe(150);
  });
});

describe('ScannedPdfOcrService — decide (deterministic, do not pick OCR if worse)', () => {
  it('used_ocr: thin original, rich OCR (rule 3 skipped for thin original)', () => {
    const O = M({ charCount: 32, wordCount: 6, wordlikeRatio: 0.95 });
    const R = M({ charCount: 800, wordCount: 120, wordlikeRatio: 0.85, skillsFound: 5 });
    expect(svc().decideForTest(O, R)).toEqual({ useOcr: true });
  });

  it('rule 3 SKIPPED for thin original even when R.wordlike < O.wordlike-0.05 (floor 0.60 only)', () => {
    const O = M({ charCount: 32, wordCount: 5, wordlikeRatio: 0.99 }); // thin → rule 3 off
    const R = M({ charCount: 400, wordCount: 70, wordlikeRatio: 0.62, skillsFound: 3 });
    expect(svc().decideForTest(O, R).useOcr).toBe(true);
  });

  it('rule 3 ENFORCED for substantial original: 0.84 kept, 0.86 used (only wordlike varies)', () => {
    const O = M({ charCount: 400, wordCount: 70, wordlikeRatio: 0.9, skillsFound: 1 });
    // base makes rules 1,2,4,5 pass by construction so the assertion turns on rule 3 alone:
    const base = { charCount: 900, wordCount: 150, mojibakeRatio: 0, skillsFound: 2 };
    expect(svc().decideForTest(O, M({ ...base, wordlikeRatio: 0.84 })).useOcr).toBe(false);
    expect(svc().decideForTest(O, M({ ...base, wordlikeRatio: 0.86 })).useOcr).toBe(true);
  });

  it('rule 1 fail: only ~1.2x chars → kept', () => {
    const O = M({ charCount: 300, wordCount: 60, wordlikeRatio: 0.8 });
    const R = M({ charCount: 360, wordlikeRatio: 0.9, skillsFound: 0 });
    expect(svc().decideForTest(O, R)).toEqual({ useOcr: false, reason: 'ocr_not_better' });
  });

  it('rule 2 fail: R.wordlike below 0.60 floor → kept', () => {
    const O = M({ charCount: 32, wordlikeRatio: 0.9 });
    const R = M({ charCount: 800, wordlikeRatio: 0.4 });
    expect(svc().decideForTest(O, R).useOcr).toBe(false);
  });

  it('rule 4 fail: R mojibake above O+0.01 → kept', () => {
    const O = M({ charCount: 32, wordlikeRatio: 0.9, mojibakeRatio: 0 });
    const R = M({ charCount: 800, wordlikeRatio: 0.8, mojibakeRatio: 0.02 });
    expect(svc().decideForTest(O, R).useOcr).toBe(false);
  });

  it('rule 5 fail: R.skillsFound < O.skillsFound → kept', () => {
    const O = M({ charCount: 32, wordlikeRatio: 0.9, skillsFound: 4 });
    const R = M({ charCount: 800, wordlikeRatio: 0.8, skillsFound: 2 });
    expect(svc().decideForTest(O, R).useOcr).toBe(false);
  });

  it('rule 1 boundary is inclusive (>=)', () => {
    const O = M({ charCount: 100, wordlikeRatio: 0.9 }); // max(200, 150) = 200
    const R = M({ charCount: 200, wordlikeRatio: 0.9, skillsFound: 0 });
    expect(svc().decideForTest(O, R).useOcr).toBe(true);
  });
});

type WorkerResult = { text: string; pages: number; renderMs: number; ocrMs: number };

describe('ScannedPdfOcrService — rescue (never-throws, worker injected, no thread/WASM/network)', () => {
  class FakeOcr extends ScannedPdfOcrService {
    constructor(
      over: Record<string, unknown>,
      scanStub: ScannerLike,
      private readonly hooks: {
        result?: () => Promise<WorkerResult>;
        terminate?: () => Promise<void>;
      },
    ) {
      super(cfg(over), scanStub);
    }
    protected runOcr() {
      return {
        result: this.hooks.result
          ? this.hooks.result()
          : Promise.resolve({ text: '', pages: 0, renderMs: 0, ocrMs: 0 }),
        terminate: this.hooks.terminate ?? (async () => {}),
      };
    }
  }

  const buf = Buffer.from('x'.repeat(50));
  const rejectWith = (stage: 'render' | 'ocr') => () =>
    Promise.reject(Object.assign(new Error(`${stage} boom`), { stage }));

  it('disabled → kept_original, attempted:false', async () => {
    const s = new FakeOcr({ 'ocrFallback.enabled': false }, scanner, {});
    const r = await s.rescue(buf, 'orig');
    expect(r).toMatchObject({
      text: 'orig',
      ocrUsed: false,
      metadata: { decision: 'kept_original', reason: 'disabled', attempted: false },
    });
  });

  it('oversized → kept_original reason:oversized', async () => {
    const s = new FakeOcr({ 'ocrFallback.maxPdfBytes': 10 }, scanner, {});
    const r = await s.rescue(buf, 'orig');
    expect(r.metadata.reason).toBe('oversized');
  });

  it('render stage error → render_failed, worker terminated', async () => {
    const terminate = jest.fn(async () => {});
    const s = new FakeOcr({}, scanner, { result: rejectWith('render'), terminate });
    const r = await s.rescue(buf, 'orig');
    expect(r.text).toBe('orig');
    expect(r.metadata.reason).toBe('render_failed');
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('ocr stage error → ocr_failed, worker terminated', async () => {
    const terminate = jest.fn(async () => {});
    const s = new FakeOcr({}, scanner, { result: rejectWith('ocr'), terminate });
    const r = await s.rescue(buf, 'orig');
    expect(r.metadata.reason).toBe('ocr_failed');
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('empty render (0 pages, no text) → empty_render', async () => {
    const s = new FakeOcr({}, scanner, {
      result: async () => ({ text: '', pages: 0, renderMs: 5, ocrMs: 0 }),
    });
    const r = await s.rescue(buf, 'orig');
    expect(r.metadata.reason).toBe('empty_render');
    expect(r.ocrUsed).toBe(false);
  });

  it('timeout (result never resolves) → timeout, worker terminated once', async () => {
    const terminate = jest.fn(async () => {});
    const s = new FakeOcr({ 'ocrFallback.timeoutMs': 20 }, scanner, {
      result: () => new Promise<WorkerResult>(() => {}), // never resolves
      terminate,
    });
    const r = await s.rescue(buf, 'orig');
    expect(r.metadata.reason).toBe('timeout');
    expect(r.ocrUsed).toBe(false);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('used_ocr: rich OCR text selected, worker terminated on success too', async () => {
    const terminate = jest.fn(async () => {});
    const s = new FakeOcr({}, scanner, {
      result: async () => ({ text: 'react '.repeat(80), pages: 1, renderMs: 10, ocrMs: 20 }),
      terminate,
    });
    const r = await s.rescue(buf, 'orig');
    expect(r.ocrUsed).toBe(true);
    expect(r.metadata.decision).toBe('used_ocr');
    expect(r.metadata.ocr).toBeDefined();
    expect(r.metadata.pagesRendered).toBe(1);
    expect(r.text).toContain('react');
    expect(terminate).toHaveBeenCalledTimes(1); // finally terminates even on success
  });

  it('used_ocr counts skills via the shared scanner (rule 5)', async () => {
    const richScanner = {
      scan: (t: string) => (t.includes('react') ? [{ canonical_name: 'react' }] : []),
    } as unknown as ScannerLike;
    const s = new FakeOcr({}, richScanner, {
      result: async () => ({
        text: 'react typescript '.repeat(40),
        pages: 1,
        renderMs: 1,
        ocrMs: 1,
      }),
    });
    const r = await s.rescue(buf, 'orig');
    expect(r.ocrUsed).toBe(true);
    expect(r.metadata.ocr?.skillsFound).toBeGreaterThanOrEqual(1);
  });

  it('ocr_not_better: junk OCR → kept_original', async () => {
    const s = new FakeOcr({}, scanner, {
      result: async () => ({ text: 'x', pages: 1, renderMs: 1, ocrMs: 1 }),
    });
    const r = await s.rescue(buf, 'orig');
    expect(r.ocrUsed).toBe(false);
    expect(r.metadata.reason).toBe('ocr_not_better');
  });

  it('metadata is PII-safe: only TextMetrics + timings + decision, no raw CV text', async () => {
    const s = new FakeOcr({}, scanner, {
      result: async () => ({ text: 'react '.repeat(80), pages: 1, renderMs: 1, ocrMs: 1 }),
    });
    const { metadata } = await s.rescue(buf, 'orig');
    expect(Object.keys(metadata).sort()).toEqual(
      ['attempted', 'decision', 'ocr', 'ocrMs', 'original', 'pagesRendered', 'renderMs'].sort(),
    );
    expect(metadata.original).not.toHaveProperty('text');
    expect(JSON.stringify(metadata)).not.toContain('react react'); // OCR body never embedded
  });
});

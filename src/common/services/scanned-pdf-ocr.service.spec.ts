import { ConfigService } from '@nestjs/config';
import { ScannedPdfOcrService } from './scanned-pdf-ocr.service';
import { TextMetrics } from './text-metrics';

/** Stub ConfigService backed by a plain map (dot-path keys, e.g. 'ocrFallback.maxPages'). */
const cfg = (over: Record<string, unknown> = {}): ConfigService =>
  ({ get: (k: string) => over[k] }) as unknown as ConfigService;

const scanner = {
  scan: () => [],
} as unknown as import('./skill-text-scanner.service').SkillTextScannerService;

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

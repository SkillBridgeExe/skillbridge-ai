/**
 * OCR worker_thread entry. Runs the HEAVY, blocking work off the main event loop so the request
 * thread stays responsive AND the whole thread can be hard-terminated on timeout (which is the only
 * reliable way to interrupt a stuck Tesseract load or a slow WASM render — killing the thread frees
 * pdfium's WASM heap and Tesseract's nested worker in one shot, with no leak).
 *
 * Pipeline (all permissive, native-free): @hyzyla/pdfium (WASM, MIT/BSD) rasterizes pages → pngjs
 * (pure JS, MIT) encodes BGRA→PNG → tesseract.js (WASM) OCRs eng+vie.
 *
 * Compiled to dist/common/services/ocr-worker.js for production; run via ts-node in dev/eval.
 * It is spawned by ScannedPdfOcrService.runOcr() and communicates ONLY via worker messages.
 */
import { parentPort, workerData } from 'worker_threads';
import { PDFiumLibrary } from '@hyzyla/pdfium';
import { PNG } from 'pngjs';
import { createWorker } from 'tesseract.js';

export interface OcrWorkerInput {
  pdf: Uint8Array;
  maxPages: number;
  dpi: number;
  cachePath: string;
}

export type OcrWorkerResult =
  | { ok: true; text: string; pages: number; renderMs: number; ocrMs: number }
  | { ok: false; stage: 'render' | 'ocr'; message: string };

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Rasterize up to maxPages pages to PNG buffers via pdfium + pngjs. Frees WASM handles. */
async function renderPages(pdf: Uint8Array, maxPages: number, dpi: number): Promise<Buffer[]> {
  const out: Buffer[] = [];
  const lib = await PDFiumLibrary.init();
  try {
    const doc = await lib.loadDocument(pdf);
    try {
      const n = Math.min(doc.getPageCount(), maxPages);
      for (let i = 0; i < n; i++) {
        const page = doc.getPage(i);
        const bitmap = await page.render({ render: 'bitmap', scale: dpi / 72 });
        out.push(bgraToPng(bitmap));
      }
    } finally {
      doc.destroy();
    }
  } finally {
    lib.destroy();
  }
  return out;
}

/** pdfium returns a raw BGRA bitmap; pngjs expects RGBA, so swap B/R per pixel. */
function bgraToPng(bitmap: { width: number; height: number; data: Uint8Array }): Buffer {
  const png = new PNG({ width: bitmap.width, height: bitmap.height });
  const { data } = bitmap;
  for (let j = 0; j < data.length; j += 4) {
    png.data[j] = data[j + 2];
    png.data[j + 1] = data[j + 1];
    png.data[j + 2] = data[j];
    png.data[j + 3] = data[j + 3];
  }
  return PNG.sync.write(png);
}

/** OCR each PNG with a managed eng+vie Tesseract worker; always terminate it. */
async function ocrPages(pngs: Buffer[], cachePath: string): Promise<string> {
  const worker = await createWorker('eng+vie', undefined, { cachePath });
  try {
    const parts: string[] = [];
    for (const png of pngs) {
      const res = await worker.recognize(png);
      parts.push(res.data.text);
    }
    return parts.join('\n');
  } finally {
    await worker.terminate();
  }
}

async function run(input: OcrWorkerInput): Promise<OcrWorkerResult> {
  let pngs: Buffer[];
  const t0 = Date.now();
  try {
    pngs = await renderPages(input.pdf, input.maxPages, input.dpi);
  } catch (e) {
    return { ok: false, stage: 'render', message: errMsg(e) };
  }
  const renderMs = Date.now() - t0;

  const t1 = Date.now();
  try {
    const text = pngs.length === 0 ? '' : await ocrPages(pngs, input.cachePath);
    return { ok: true, text, pages: pngs.length, renderMs, ocrMs: Date.now() - t1 };
  } catch (e) {
    return { ok: false, stage: 'ocr', message: errMsg(e) };
  }
}

// Only execute when actually spawned as a worker (not when imported for its types).
if (parentPort) {
  run(workerData as OcrWorkerInput)
    .then((result) => parentPort!.postMessage(result))
    .catch((e) => parentPort!.postMessage({ ok: false, stage: 'render', message: errMsg(e) }));
}

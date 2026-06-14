import { BadGatewayException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PDFParse } from 'pdf-parse';
import * as mammoth from 'mammoth';
import * as Tesseract from 'tesseract.js';
import { TextExtractorService } from '../../../src/platform/cvs/text-extractor.service';
import { ScannedPdfOcrService } from '../../../src/common/services/scanned-pdf-ocr.service';
import { SkillTextScannerService } from '../../../src/common/services/skill-text-scanner.service';

jest.mock('pdf-parse', () => ({ PDFParse: jest.fn() }));
jest.mock('mammoth', () => ({ extractRawText: jest.fn() }));
jest.mock('tesseract.js', () => ({ recognize: jest.fn(), createWorker: jest.fn() }));

const MockPDFParse = PDFParse as unknown as jest.Mock;

const pdfFile = (buffer = Buffer.from('pdf')): Express.Multer.File =>
  ({ mimetype: 'application/pdf', buffer }) as Express.Multer.File;

const setPdfText = (getText: () => Promise<{ text: string }>) =>
  MockPDFParse.mockImplementation(() => ({ getText, destroy: async () => undefined }));

const fakeOcr = (impl: (b: Buffer, t: string) => Promise<unknown>) =>
  ({ rescue: jest.fn(impl) }) as unknown as ScannedPdfOcrService & { rescue: jest.Mock };

beforeEach(() => jest.clearAllMocks());

describe('TextExtractorService — PDF with optional OCR fallback', () => {
  it('rich text-layer PDF: returns text, isOcrOnly false, rescue NOT called', async () => {
    setPdfText(async () => ({ text: 'Backend developer Node.js PostgreSQL React. '.repeat(15) }));
    const ocr = fakeOcr(async () => ({ text: 'X', ocrUsed: true, metadata: {} }));
    const svc = new TextExtractorService(ocr);

    const r = await svc.extract(pdfFile());

    expect(r.isOcrOnly).toBe(false);
    expect(r.text).toContain('Backend developer');
    expect(ocr.rescue).not.toHaveBeenCalled();
  });

  it('thin PDF triggers rescue → OCR text + isOcrOnly true', async () => {
    setPdfText(async () => ({ text: 'short cv text — only a few chars.' }));
    const ocr = fakeOcr(async () => ({ text: 'RICH OCR RESULT', ocrUsed: true, metadata: {} }));
    const svc = new TextExtractorService(ocr);

    const r = await svc.extract(pdfFile());

    expect(ocr.rescue).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ text: 'RICH OCR RESULT', isOcrOnly: true });
  });

  it('thin PDF, rescue keeps original → isOcrOnly false', async () => {
    setPdfText(async () => ({ text: 'tiny cv text' }));
    const ocr = fakeOcr(async (_b, t) => ({ text: t, ocrUsed: false, metadata: {} }));
    const svc = new TextExtractorService(ocr);

    const r = await svc.extract(pdfFile());

    expect(r).toEqual({ text: 'tiny cv text', isOcrOnly: false });
  });

  it('pdf-parse throws + OCR rescues → OCR text, no throw (requireText runs AFTER rescue)', async () => {
    setPdfText(async () => {
      throw new Error('corrupt pdf');
    });
    const ocr = fakeOcr(async () => ({ text: 'OCR SAVED IT', ocrUsed: true, metadata: {} }));
    const svc = new TextExtractorService(ocr);

    const r = await svc.extract(pdfFile());

    expect(ocr.rescue).toHaveBeenCalledWith(expect.any(Buffer), '');
    expect(r).toEqual({ text: 'OCR SAVED IT', isOcrOnly: true });
  });

  it('all-empty PDF + no OCR service → throws CV_PARSE_FAILED', async () => {
    setPdfText(async () => ({ text: '' }));
    const svc = new TextExtractorService(); // OCR dep absent

    await expect(svc.extract(pdfFile())).rejects.toBeInstanceOf(BadGatewayException);
  });
});

describe('TextExtractorService — DOCX / image branches unchanged', () => {
  it('DOCX: mammoth text, isOcrOnly false', async () => {
    (mammoth.extractRawText as jest.Mock).mockResolvedValue({ value: 'docx resume content' });
    const svc = new TextExtractorService();

    const r = await svc.extract({
      mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: Buffer.from('d'),
    } as Express.Multer.File);

    expect(r).toEqual({ text: 'docx resume content', isOcrOnly: false });
  });

  it('image: tesseract OCR, isOcrOnly true', async () => {
    (Tesseract.recognize as jest.Mock).mockResolvedValue({ data: { text: 'image cv text' } });
    const svc = new TextExtractorService();

    const r = await svc.extract({
      mimetype: 'image/png',
      buffer: Buffer.from('i'),
    } as Express.Multer.File);

    expect(r).toEqual({ text: 'image cv text', isOcrOnly: true });
  });
});

describe('TextExtractorService — DI wiring', () => {
  it('resolves at runtime with the OCR provider present', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        TextExtractorService,
        ScannedPdfOcrService,
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: SkillTextScannerService, useValue: { scan: () => [] } },
      ],
    }).compile();

    expect(moduleRef.get(TextExtractorService)).toBeInstanceOf(TextExtractorService);
    expect(moduleRef.get(ScannedPdfOcrService)).toBeInstanceOf(ScannedPdfOcrService);
  });
});

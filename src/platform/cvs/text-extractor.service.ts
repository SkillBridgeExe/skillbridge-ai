import {
  BadGatewayException,
  Injectable,
  Optional,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { PDFParse } from 'pdf-parse';
import * as mammoth from 'mammoth';
import * as Tesseract from 'tesseract.js';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { ScannedPdfOcrService } from '../../common/services/scanned-pdf-ocr.service';
import { computeTextMetrics } from '../../common/services/text-metrics';

export interface ExtractedCvText {
  text: string;
  isOcrOnly: boolean;
}

const PDF_MIME = 'application/pdf';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);

@Injectable()
export class TextExtractorService {
  // Optional so the extractor is still constructible without OCR (unit contexts). @Optional()
  // is REQUIRED for runtime optional injection — the `?` in the type alone is not enough.
  constructor(@Optional() private readonly scannedPdfOcr?: ScannedPdfOcrService) {}

  async extract(file: Express.Multer.File): Promise<ExtractedCvText> {
    if (file.mimetype === PDF_MIME) {
      return this.extractPdf(file.buffer);
    }
    if (file.mimetype === DOCX_MIME) {
      return { text: await this.extractDocx(file.buffer), isOcrOnly: false };
    }
    if (IMAGE_MIMES.has(file.mimetype)) {
      return { text: await this.extractImage(file.buffer), isOcrOnly: true };
    }

    throw new UnsupportedMediaTypeException({
      errorCode: ERROR_CODES.UNSUPPORTED_FILE_TYPE,
      message: 'Only PDF, DOCX, PNG, JPG, and WEBP CV files are supported',
    });
  }

  private async extractPdf(buffer: Buffer): Promise<ExtractedCvText> {
    // 1. Raw text WITHOUT throwing — a text-less / scanned PDF must reach the OCR rescue, not
    //    fail here. pdf-parse errors degrade to empty text rather than propagating.
    let rawText = '';
    const parser = new PDFParse({ data: buffer });
    try {
      rawText = (await parser.getText()).text ?? '';
    } catch {
      rawText = '';
    } finally {
      await parser.destroy().catch(() => undefined);
    }

    // 2. Normalize ONCE (NUL-strip + trim, same as requireText) so the original metrics seen by
    //    the rescue match the parsedText that gets persisted downstream.
    const normalizedRaw = rawText.split(String.fromCharCode(0)).join('').trim();

    // 3. Thin trigger computed from raw-text metrics only (skill count is irrelevant to the
    //    trigger → empty scan keeps the extractor scanner-free).
    const m = computeTextMetrics(normalizedRaw, () => []);
    const isThin = m.charCount < 300 || m.wordCount < 50 || m.wordlikeRatio < 0.55;

    // 4. OCR rescue only when thin AND the optional service is wired. rescue() never throws.
    let chosen = normalizedRaw;
    let ocrUsed = false;
    if (isThin && this.scannedPdfOcr) {
      const rescued = await this.scannedPdfOcr.rescue(buffer, normalizedRaw);
      chosen = rescued.text;
      ocrUsed = rescued.ocrUsed;
    }

    // 5. SINGLE throw point (invariant): only fails when the chosen text is empty — i.e. a real
    //    all-empty PDF with OCR disabled/failed. OCR chosen ⇒ isOcrOnly=true (honest for ATS).
    return { text: this.requireText(chosen), isOcrOnly: ocrUsed };
  }

  private async extractDocx(buffer: Buffer): Promise<string> {
    try {
      const result = await mammoth.extractRawText({ buffer });
      return this.requireText(result.value);
    } catch (error) {
      throw this.parseFailed(error);
    }
  }

  private async extractImage(buffer: Buffer): Promise<string> {
    try {
      const result = await Tesseract.recognize(buffer, 'eng+vie');
      return this.requireText(result.data.text);
    } catch (error) {
      throw this.parseFailed(error);
    }
  }

  private requireText(text: string): string {
    const normalized = text.replace(/\u0000/g, '').trim();
    if (normalized.length === 0) {
      throw this.parseFailed(new Error('No readable text found in CV file'));
    }
    return normalized;
  }

  private parseFailed(error: unknown): BadGatewayException {
    return new BadGatewayException({
      errorCode: ERROR_CODES.CV_PARSE_FAILED,
      message: error instanceof Error ? error.message : 'CV text extraction failed',
    });
  }
}

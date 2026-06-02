import { BadGatewayException, Injectable, UnsupportedMediaTypeException } from '@nestjs/common';
import { PDFParse } from 'pdf-parse';
import * as mammoth from 'mammoth';
import * as Tesseract from 'tesseract.js';
import { ERROR_CODES } from '../../common/constants/error-codes';

export interface ExtractedCvText {
  text: string;
  isOcrOnly: boolean;
}

const PDF_MIME = 'application/pdf';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);

@Injectable()
export class TextExtractorService {
  async extract(file: Express.Multer.File): Promise<ExtractedCvText> {
    if (file.mimetype === PDF_MIME) {
      return { text: await this.extractPdf(file.buffer), isOcrOnly: false };
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

  private async extractPdf(buffer: Buffer): Promise<string> {
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return this.requireText(result.text);
    } catch (error) {
      throw this.parseFailed(error);
    } finally {
      await parser.destroy().catch(() => undefined);
    }
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

import { BadGatewayException, Injectable, UnsupportedMediaTypeException } from '@nestjs/common';
import { PDFParse } from 'pdf-parse';
import * as mammoth from 'mammoth';
import { ERROR_CODES } from '../../common/constants/error-codes';

const PDF_MIME = 'application/pdf';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const TEXT_MIMES = new Set(['text/plain', 'application/octet-stream']);

@Injectable()
export class JdTextExtractorService {
  async extract(file: Express.Multer.File): Promise<string> {
    if (TEXT_MIMES.has(file.mimetype)) return this.requireText(file.buffer.toString('utf8'));
    if (file.mimetype === PDF_MIME) return this.extractPdf(file.buffer);
    if (file.mimetype === DOCX_MIME) return this.extractDocx(file.buffer);

    throw new UnsupportedMediaTypeException({
      errorCode: ERROR_CODES.UNSUPPORTED_FILE_TYPE,
      message: 'Only TXT, PDF, and DOCX job description files are supported',
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

  private requireText(text: string): string {
    const normalized = text.replace(/\u0000/g, '').trim();
    if (normalized.length === 0) {
      throw this.parseFailed(new Error('No readable text found in job description file'));
    }
    return normalized;
  }

  private parseFailed(error: unknown): BadGatewayException {
    return new BadGatewayException({
      errorCode: ERROR_CODES.AI_ANALYSIS_FAILED,
      message: error instanceof Error ? error.message : 'Job description text extraction failed',
    });
  }
}

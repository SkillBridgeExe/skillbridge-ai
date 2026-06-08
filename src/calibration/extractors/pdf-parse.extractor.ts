import { PDFParse } from 'pdf-parse';

/** Extract text via pdf-parse — the CURRENT platform extractor (the baseline to beat). */
export async function pdfParseExtract(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

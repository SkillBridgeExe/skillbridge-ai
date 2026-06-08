import { extractText, getDocumentProxy } from 'unpdf';

/** Extract text via unpdf (PDF.js, pure-JS). mergePages → single string. */
export async function unpdfExtract(buffer: Buffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

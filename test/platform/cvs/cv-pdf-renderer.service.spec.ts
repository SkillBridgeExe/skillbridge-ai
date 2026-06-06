import { PDFDocument } from 'pdf-lib';
import { CvPdfRendererService } from '../../../src/platform/cvs/cv-pdf-renderer.service';

describe('CvPdfRendererService', () => {
  it('embeds and extracts the SkillBridge cv_id fingerprint from PDF metadata', async () => {
    const service = new CvPdfRendererService({ get: jest.fn() } as never);
    const document = await PDFDocument.create();
    document.addPage([200, 200]);
    const original = Buffer.from(await document.save());

    const withFingerprint = await service.embedSkillbridgeFingerprint(original, 'cv-123');
    const extracted = await service.extractSkillbridgeFingerprint({
      mimetype: 'application/pdf',
      buffer: withFingerprint,
    } as Express.Multer.File);

    expect(extracted).toBe('cv-123');
  });

  it('returns null when the uploaded file is not a SkillBridge generated PDF', async () => {
    const service = new CvPdfRendererService({ get: jest.fn() } as never);
    const document = await PDFDocument.create();
    document.addPage([200, 200]);

    const extracted = await service.extractSkillbridgeFingerprint({
      mimetype: 'application/pdf',
      buffer: Buffer.from(await document.save()),
    } as Express.Multer.File);

    expect(extracted).toBeNull();
  });
});

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: jest.fn(),
}));

import { PDFDocument } from 'pdf-lib';
import { existsSync } from 'fs';
import { ServiceUnavailableException } from '@nestjs/common';
import { CvPdfRendererService } from '../../../src/platform/cvs/cv-pdf-renderer.service';
import { emptyCanonicalCv } from '../../../src/common/types/canonical-cv';

describe('CvPdfRendererService', () => {
  const existsSyncMock = jest.mocked(existsSync);

  afterEach(() => {
    existsSyncMock.mockReset();
  });

  it('resolves Chrome from env before known Cloud Run paths', () => {
    existsSyncMock.mockImplementation((path) => path === '/custom/chrome');
    const service = new CvPdfRendererService({
      get: jest.fn((key: string) =>
        key === 'PUPPETEER_EXECUTABLE_PATH' ? '/custom/chrome' : undefined,
      ),
    } as never);

    expect(
      (service as never as { resolveExecutablePath: () => string }).resolveExecutablePath(),
    ).toBe('/custom/chrome');
  });

  it('falls back to the Alpine Chromium path when env is not configured', () => {
    existsSyncMock.mockImplementation((path) => path === '/usr/bin/chromium-browser');
    const service = new CvPdfRendererService({ get: jest.fn() } as never);

    expect(
      (service as never as { resolveExecutablePath: () => string }).resolveExecutablePath(),
    ).toBe('/usr/bin/chromium-browser');
  });

  it('throws PDF_RENDERER_UNAVAILABLE when no Chrome executable is available', () => {
    existsSyncMock.mockReturnValue(false);
    const service = new CvPdfRendererService({ get: jest.fn() } as never);

    expect(() =>
      (service as never as { resolveExecutablePath: () => string }).resolveExecutablePath(),
    ).toThrow(ServiceUnavailableException);

    try {
      (service as never as { resolveExecutablePath: () => string }).resolveExecutablePath();
    } catch (error) {
      expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
        errorCode: 'PDF_RENDERER_UNAVAILABLE',
      });
    }
  });

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

  it('includes project links in the generated CV HTML', () => {
    const service = new CvPdfRendererService({ get: jest.fn() } as never);
    const document = emptyCanonicalCv();
    document.projects = [
      {
        name: 'StudyMate',
        role: 'Backend Developer',
        tech: ['NestJS'],
        bullets: ['Built the API.'],
        link: 'https://github.com/example/studymate',
      },
    ];

    const html = (
      service as never as { buildHarvardHtml: (doc: typeof document) => string }
    ).buildHarvardHtml(document);

    expect(html).toContain('https://github.com/example/studymate');
  });
});

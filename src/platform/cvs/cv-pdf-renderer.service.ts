import { existsSync } from 'fs';
import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PDFDocument } from 'pdf-lib';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { CanonicalCvDocument } from '../../common/types/canonical-cv';
import { CvEntity } from '../../database/entities/cv.entity';

const FINGERPRINT_PREFIX = 'skillbridge:cv:';
const CHROME_EXECUTABLE_CANDIDATES = [
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome-stable',
] as const;

export interface RenderedCvPdf {
  buffer: Buffer;
  fileName: string;
}

@Injectable()
export class CvPdfRendererService {
  constructor(private readonly config: ConfigService) {}

  async renderHarvardPdf(cv: CvEntity): Promise<RenderedCvPdf> {
    if (!cv.parsedJson) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.CV_PARSE_FAILED,
        message: 'CV has no structured builder data to render',
      });
    }

    const executablePath = this.resolveExecutablePath();
    const puppeteer = await this.loadPuppeteer();
    const browser = await puppeteer.launch({
      headless: true,
      executablePath,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    try {
      const page = await browser.newPage();
      await page.setContent(this.buildHarvardHtml(cv.parsedJson), { waitUntil: 'load' });
      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '18mm', right: '18mm', bottom: '18mm', left: '18mm' },
      });
      const buffer = await this.embedSkillbridgeFingerprint(Buffer.from(pdf), cv.id);
      return {
        buffer,
        fileName: this.fileName(cv),
      };
    } finally {
      await browser.close();
    }
  }

  async embedSkillbridgeFingerprint(input: Buffer, cvId: string): Promise<Buffer> {
    const pdf = await PDFDocument.load(input);
    const marker = `${FINGERPRINT_PREFIX}${cvId}`;
    pdf.setSubject(marker);
    pdf.setKeywords([marker]);
    pdf.setCreator('SkillBridge CV Builder');
    pdf.setProducer('SkillBridge');
    return Buffer.from(await pdf.save());
  }

  async extractSkillbridgeFingerprint(file: Express.Multer.File): Promise<string | null> {
    if (file.mimetype !== 'application/pdf') return null;
    try {
      const pdf = await PDFDocument.load(file.buffer, { ignoreEncryption: true });
      const candidates = [pdf.getSubject(), pdf.getTitle(), pdf.getKeywords()].filter(
        (value): value is string => typeof value === 'string' && value.length > 0,
      );
      for (const value of candidates) {
        const match = value.match(/skillbridge:cv:([A-Za-z0-9_-]+)/);
        if (match?.[1]) return match[1];
      }
    } catch {
      return null;
    }
    return null;
  }

  private resolveExecutablePath(): string {
    const configuredPath = this.config.get<string>('PUPPETEER_EXECUTABLE_PATH')?.trim();
    const candidates = configuredPath
      ? [configuredPath, ...CHROME_EXECUTABLE_CANDIDATES]
      : [...CHROME_EXECUTABLE_CANDIDATES];
    const executablePath = candidates.find((candidate) => existsSync(candidate));

    if (executablePath) return executablePath;

    throw new ServiceUnavailableException({
      errorCode: ERROR_CODES.PDF_RENDERER_UNAVAILABLE,
      message: 'PDF rendering is unavailable because Chrome or Chromium is not installed.',
    });
  }

  private buildHarvardHtml(doc: CanonicalCvDocument): string {
    const contact = doc.contact;
    const contactLine = [
      contact.email,
      contact.phone,
      contact.location,
      ...contact.links.map((link) => link.url),
    ]
      .filter(Boolean)
      .map((value) => this.escape(String(value)))
      .join(' | ');

    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    body { font-family: Arial, Helvetica, sans-serif; color: #111; font-size: 11px; line-height: 1.35; }
    h1 { font-size: 22px; text-align: center; margin: 0 0 4px; letter-spacing: 0; }
    .contact { text-align: center; margin-bottom: 14px; }
    h2 { font-size: 13px; border-bottom: 1px solid #111; margin: 14px 0 6px; text-transform: uppercase; letter-spacing: 0; }
    .row { display: flex; justify-content: space-between; gap: 12px; margin-top: 6px; }
    .main { font-weight: 700; }
    .meta { white-space: nowrap; }
    ul { margin: 3px 0 0 18px; padding: 0; }
    li { margin: 2px 0; }
    p { margin: 0; }
  </style>
</head>
<body>
  <h1>${this.escape(contact.name ?? 'Untitled CV')}</h1>
  <div class="contact">${contactLine}</div>
  ${this.summary(doc)}
  ${this.experience(doc)}
  ${this.projects(doc)}
  ${this.education(doc)}
  ${this.skills(doc)}
  ${this.certifications(doc)}
  ${this.activities(doc)}
</body>
</html>`;
  }

  private summary(doc: CanonicalCvDocument): string {
    if (!doc.summary.trim()) return '';
    return `<h2>Summary</h2><p>${this.escape(doc.summary)}</p>`;
  }

  private experience(doc: CanonicalCvDocument): string {
    if (doc.experience.length === 0) return '';
    return `<h2>Experience</h2>${doc.experience
      .map(
        (entry) =>
          `<div class="row"><div><span class="main">${this.escape(entry.role ?? '')}</span>${entry.org ? `, ${this.escape(entry.org)}` : ''}</div><div class="meta">${this.dateRange(entry.start, entry.end)}</div></div>${this.bullets(entry.bullets)}`,
      )
      .join('')}`;
  }

  private projects(doc: CanonicalCvDocument): string {
    if (doc.projects.length === 0) return '';
    return `<h2>Projects</h2>${doc.projects
      .map(
        (entry) =>
          `<div class="row"><div><span class="main">${this.escape(entry.name)}</span>${entry.tech.length ? ` | ${this.escape(entry.tech.join(', '))}` : ''}</div><div class="meta">${this.escape(entry.role ?? '')}</div></div>${entry.link ? `<p>${this.escape(entry.link)}</p>` : ''}${this.bullets(entry.bullets)}`,
      )
      .join('')}`;
  }

  private education(doc: CanonicalCvDocument): string {
    if (doc.education.length === 0) return '';
    return `<h2>Education</h2>${doc.education
      .map(
        (entry) =>
          `<div class="row"><div><span class="main">${this.escape(entry.school)}</span>${entry.degree ? `, ${this.escape(entry.degree)}` : ''}${entry.field ? `, ${this.escape(entry.field)}` : ''}</div><div class="meta">${this.dateRange(entry.start, entry.end)}</div></div>${this.bullets(entry.highlights)}`,
      )
      .join('')}`;
  }

  private skills(doc: CanonicalCvDocument): string {
    const rows = [
      ['Technical', doc.skills.technical],
      ['Tools', doc.skills.tools],
      ['Languages', doc.skills.languages],
      ['Soft Skills', doc.skills.soft],
    ].filter(([, values]) => (values as string[]).length > 0);
    if (rows.length === 0) return '';
    return `<h2>Skills</h2>${rows
      .map(
        ([label, values]) =>
          `<p><strong>${label}:</strong> ${this.escape((values as string[]).join(', '))}</p>`,
      )
      .join('')}`;
  }

  private certifications(doc: CanonicalCvDocument): string {
    if (doc.certifications.length === 0) return '';
    return `<h2>Certifications</h2>${doc.certifications
      .map(
        (entry) =>
          `<div class="row"><div><span class="main">${this.escape(entry.name)}</span>${entry.issuer ? `, ${this.escape(entry.issuer)}` : ''}</div><div class="meta">${this.escape(entry.date ?? '')}</div></div>`,
      )
      .join('')}`;
  }

  private activities(doc: CanonicalCvDocument): string {
    if (doc.activities.length === 0) return '';
    return `<h2>Activities</h2>${doc.activities
      .map(
        (entry) =>
          `<div class="row"><div><span class="main">${this.escape(entry.role ?? '')}</span>${entry.org ? `, ${this.escape(entry.org)}` : ''}</div></div>${this.bullets(entry.bullets)}`,
      )
      .join('')}`;
  }

  private bullets(items: string[]): string {
    const safe = items.map((item) => item.trim()).filter(Boolean);
    if (safe.length === 0) return '';
    return `<ul>${safe.map((item) => `<li>${this.escape(item)}</li>`).join('')}</ul>`;
  }

  private dateRange(start: string | null, end: string | null): string {
    return [start, end]
      .filter(Boolean)
      .map((value) => this.escape(String(value)))
      .join(' - ');
  }

  private fileName(cv: CvEntity): string {
    const source = cv.title?.trim() || cv.parsedJson?.contact.name || cv.id;
    return `${source.replace(/["\\\r\n]/g, '_').slice(0, 120) || cv.id}.pdf`;
  }

  private escape(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private async loadPuppeteer(): Promise<typeof import('puppeteer')> {
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (
      specifier: string,
    ) => Promise<typeof import('puppeteer')>;
    return dynamicImport('puppeteer');
  }
}

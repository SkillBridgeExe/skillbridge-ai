/**
 * Synthetic CV corpus generator — produces PII-FREE (fictional) CV PDFs across the layout × lang grid
 * so the input-quality harness has a baseline corpus without harvesting real people's CVs (PDPL).
 *
 *   pnpm gen:synthetic-cvs
 *
 * Two fictional CVs (EN frontend, VI backend), each rendered in 4 layouts → 8 PDFs covering the full
 * target grid {single_column, two_column, canva, scanned} × {en, vi}, written to data/eval-cvs-pdf/
 * (gitignored) + a generated manifest.json (source: synthetic). Then run `pnpm eval:cv-input-quality`
 * and `pnpm eval:extractors`. Re-runnable; the user later supplements with REAL CVs (with consent).
 *
 * Layouts: single/two_column/canva are HTML→PDF (puppeteer, text layer present). `scanned` is
 * HTML→PNG→image-only PDF (pdf-lib, NO text layer) to exercise the OCR-rescue path. All data herein is
 * invented — any resemblance to real persons is coincidental.
 */
import * as fs from 'fs';
import * as path from 'path';
import { PDFDocument } from 'pdf-lib';

interface SyntheticCv {
  key: string; // filename stem, e.g. 'frontend-en'
  lang: 'en' | 'vi';
  name: string;
  title: string;
  email: string;
  phone: string;
  location: string;
  summary: string;
  skills: { technical: string[]; soft: string[] };
  experience: { role: string; company: string; period: string; bullets: string[] }[];
  projects: { name: string; desc: string }[];
  education: { degree: string; school: string; period: string }[];
  certifications: string[];
}

const CVS: SyntheticCv[] = [
  {
    key: 'frontend-en',
    lang: 'en',
    name: 'Alex Tran',
    title: 'Frontend Developer',
    email: 'alex.tran.dev@example.com',
    phone: '+84 90 000 1111',
    location: 'Ho Chi Minh City, Vietnam',
    summary:
      'Frontend developer with 3 years building responsive web apps in React and TypeScript. Strong focus on accessibility, performance and clean component design.',
    skills: {
      technical: [
        'React',
        'TypeScript',
        'JavaScript',
        'HTML',
        'CSS',
        'Tailwind',
        'Redux',
        'Vite',
        'Jest',
        'Git',
      ],
      soft: ['Communication', 'Teamwork', 'Problem solving'],
    },
    experience: [
      {
        role: 'Frontend Developer',
        company: 'Acme Web Studio',
        period: '2023 - Present',
        bullets: [
          'Built a React + TypeScript design system used across 4 products, cutting UI bug reports by 30%.',
          'Improved Largest Contentful Paint from 4.1s to 1.8s by code-splitting and image optimization.',
          'Mentored two interns on testing with Jest and React Testing Library.',
        ],
      },
      {
        role: 'Junior Web Developer',
        company: 'Bright Apps',
        period: '2021 - 2023',
        bullets: [
          'Implemented responsive landing pages with HTML, CSS and vanilla JavaScript.',
          'Integrated REST APIs and handled client-side form validation.',
        ],
      },
    ],
    projects: [
      {
        name: 'Portfolio Builder',
        desc: 'A React app to generate developer portfolios from a JSON resume.',
      },
      { name: 'Markdown Notes', desc: 'Offline-first notes PWA with IndexedDB sync.' },
    ],
    education: [
      {
        degree: 'B.Sc. in Computer Science',
        school: 'University of Science',
        period: '2017 - 2021',
      },
    ],
    certifications: ['Meta Front-End Developer Professional Certificate'],
  },
  {
    key: 'backend-vi',
    lang: 'vi',
    name: 'Nguyễn Văn An',
    title: 'Lập trình viên Backend',
    email: 'nguyen.van.an.dev@example.com',
    phone: '+84 91 222 3333',
    location: 'Hà Nội, Việt Nam',
    summary:
      'Kỹ sư backend với 4 năm kinh nghiệm xây dựng API và hệ thống microservices bằng Node.js và PostgreSQL. Quen thuộc với Docker, CI/CD và thiết kế cơ sở dữ liệu.',
    skills: {
      technical: [
        'Node.js',
        'NestJS',
        'TypeScript',
        'PostgreSQL',
        'Redis',
        'Docker',
        'Kubernetes',
        'REST',
        'GraphQL',
        'Git',
      ],
      soft: ['Giao tiếp', 'Làm việc nhóm', 'Tư duy giải quyết vấn đề'],
    },
    experience: [
      {
        role: 'Backend Engineer',
        company: 'Công ty Công nghệ FPT-like',
        period: '2022 - Hiện tại',
        bullets: [
          'Thiết kế và phát triển REST API với NestJS phục vụ hơn 100 nghìn người dùng.',
          'Tối ưu truy vấn PostgreSQL, giảm thời gian phản hồi trung bình từ 600ms xuống 180ms.',
          'Triển khai pipeline CI/CD với Docker và GitHub Actions.',
        ],
      },
      {
        role: 'Lập trình viên Junior',
        company: 'Startup Giáo dục',
        period: '2020 - 2022',
        bullets: [
          'Xây dựng các dịch vụ nền tảng bằng Node.js và Express.',
          'Viết unit test và tích hợp hệ thống thanh toán.',
        ],
      },
    ],
    projects: [
      { name: 'Hệ thống đặt lịch', desc: 'API đặt lịch hẹn với hàng đợi và thông báo realtime.' },
      { name: 'Cổng thanh toán', desc: 'Tích hợp nhiều nhà cung cấp thanh toán nội địa.' },
    ],
    education: [
      {
        degree: 'Kỹ sư Công nghệ thông tin',
        school: 'Đại học Bách Khoa Hà Nội',
        period: '2016 - 2020',
      },
    ],
    certifications: ['Chứng chỉ AWS Certified Developer – Associate'],
  },
];

const T = {
  en: {
    summary: 'Summary',
    skills: 'Skills',
    experience: 'Experience',
    projects: 'Projects',
    education: 'Education',
    certs: 'Certifications',
  },
  vi: {
    summary: 'Giới thiệu',
    skills: 'Kỹ năng',
    experience: 'Kinh nghiệm',
    projects: 'Dự án',
    education: 'Học vấn',
    certs: 'Chứng chỉ',
  },
};

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function sectionsHtml(cv: SyntheticCv): {
  contact: string;
  summary: string;
  skills: string;
  experience: string;
  projects: string;
  education: string;
  certs: string;
} {
  const t = T[cv.lang];
  return {
    contact: `<div class="contact">${esc(cv.email)} · ${esc(cv.phone)} · ${esc(cv.location)}</div>`,
    summary: `<h2>${t.summary}</h2><p>${esc(cv.summary)}</p>`,
    skills: `<h2>${t.skills}</h2><p>${esc(cv.skills.technical.join(', '))}</p><p>${esc(cv.skills.soft.join(', '))}</p>`,
    experience:
      `<h2>${t.experience}</h2>` +
      cv.experience
        .map(
          (e) =>
            `<div class="item"><b>${esc(e.role)}</b> — ${esc(e.company)} <span class="period">${esc(e.period)}</span><ul>${e.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul></div>`,
        )
        .join(''),
    projects:
      `<h2>${t.projects}</h2>` +
      cv.projects
        .map((p) => `<div class="item"><b>${esc(p.name)}</b>: ${esc(p.desc)}</div>`)
        .join(''),
    education:
      `<h2>${t.education}</h2>` +
      cv.education
        .map(
          (e) =>
            `<div class="item"><b>${esc(e.degree)}</b> — ${esc(e.school)} <span class="period">${esc(e.period)}</span></div>`,
        )
        .join(''),
    certs: `<h2>${t.certs}</h2><ul>${cv.certifications.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>`,
  };
}

const BASE_CSS = `
  * { box-sizing: border-box; font-family: 'Segoe UI', Arial, sans-serif; }
  body { margin: 0; color: #222; font-size: 12px; line-height: 1.4; }
  h1 { font-size: 22px; margin: 0; }
  .title { color: #555; font-size: 13px; margin: 2px 0 6px; }
  .contact { font-size: 11px; color: #444; }
  h2 { font-size: 13px; border-bottom: 1px solid #ccc; padding-bottom: 2px; margin: 14px 0 6px; text-transform: uppercase; letter-spacing: .5px; }
  ul { margin: 4px 0; padding-left: 18px; }
  .item { margin-bottom: 6px; }
  .period { color: #888; float: right; font-size: 11px; }
`;

function singleColumnHtml(cv: SyntheticCv): string {
  const s = sectionsHtml(cv);
  return `<html><head><meta charset="utf-8"><style>${BASE_CSS} .wrap{padding:36px;}</style></head><body><div class="wrap">
    <h1>${esc(cv.name)}</h1><div class="title">${esc(cv.title)}</div>${s.contact}
    ${s.summary}${s.skills}${s.experience}${s.projects}${s.education}${s.certs}
  </div></body></html>`;
}

function twoColumnHtml(cv: SyntheticCv): string {
  const s = sectionsHtml(cv);
  return `<html><head><meta charset="utf-8"><style>${BASE_CSS}
    .grid{display:flex;min-height:100vh;}
    .side{width:34%;background:#f3f4f6;padding:28px 20px;}
    .main{width:66%;padding:28px 24px;}
    .side h2{border-color:#bbb;}
  </style></head><body><div class="grid">
    <div class="side"><h1>${esc(cv.name)}</h1><div class="title">${esc(cv.title)}</div>${s.contact}${s.skills}${s.education}${s.certs}</div>
    <div class="main">${s.summary}${s.experience}${s.projects}</div>
  </div></body></html>`;
}

function canvaHtml(cv: SyntheticCv): string {
  const s = sectionsHtml(cv);
  return `<html><head><meta charset="utf-8"><style>${BASE_CSS}
    body{background:#fff;}
    .banner{background:linear-gradient(90deg,#0ea5e9,#6366f1);color:#fff;padding:30px 36px;}
    .banner h1{color:#fff;} .banner .title{color:#e0e7ff;} .banner .contact{color:#e0f2fe;}
    .body{padding:24px 36px;}
    h2{background:#eef2ff;border:none;color:#3730a3;padding:4px 8px;border-radius:4px;}
    .item{border-left:3px solid #c7d2fe;padding-left:10px;}
  </style></head><body>
    <div class="banner"><h1>${esc(cv.name)}</h1><div class="title">${esc(cv.title)}</div>${s.contact}</div>
    <div class="body">${s.summary}${s.skills}${s.experience}${s.projects}${s.education}${s.certs}</div>
  </body></html>`;
}

async function main(): Promise<void> {
  const outDir = path.join(process.cwd(), 'data', 'eval-cvs-pdf');
  fs.mkdirSync(outDir, { recursive: true });

  const dynamicImport = new Function('s', 'return import(s)') as (
    s: string,
  ) => Promise<typeof import('puppeteer')>;
  const puppeteer = await dynamicImport('puppeteer');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const manifest: {
    files: Array<{ filename: string; layout: string; lang: string; source: string }>;
  } = {
    files: [],
  };

  const htmlLayouts: Array<{ layout: string; html: (cv: SyntheticCv) => string }> = [
    { layout: 'single_column', html: singleColumnHtml },
    { layout: 'two_column', html: twoColumnHtml },
    { layout: 'canva', html: canvaHtml },
  ];

  for (const cv of CVS) {
    for (const { layout, html } of htmlLayouts) {
      const page = await browser.newPage();
      await page.setContent(html(cv), { waitUntil: 'load' });
      const pdf = await page.pdf({ format: 'A4', printBackground: true });
      await page.close();
      const filename = `synthetic-${cv.key}-${layout}.pdf`;
      fs.writeFileSync(path.join(outDir, filename), pdf);
      manifest.files.push({ filename, layout, lang: cv.lang, source: 'synthetic' });
      console.log(`  wrote ${filename}`);
    }

    // scanned: render single-column to a HIGH-DPI PNG, embed as an image-only PDF (no text layer) →
    // exercises the OCR-rescue path. deviceScaleFactor 3 over a 794px (A4-width) viewport ⇒ a 2382px
    // image mapped onto a true-A4 (595.28pt = 8.27in) page ⇒ ~288 PPI — a realistic scan resolution,
    // NOT the ~72 PPI a 1× screenshot would give (which no OCR engine can read).
    const A4_W = 595.28; // points
    const page = await browser.newPage();
    await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 3 });
    await page.setContent(singleColumnHtml(cv), { waitUntil: 'load' });
    const png = (await page.screenshot({ fullPage: true, type: 'png' })) as Uint8Array;
    await page.close();
    const doc = await PDFDocument.create();
    const img = await doc.embedPng(png);
    const pageH = A4_W * (img.height / img.width);
    const pg = doc.addPage([A4_W, pageH]);
    pg.drawImage(img, { x: 0, y: 0, width: A4_W, height: pageH });
    const bytes = await doc.save();
    const scannedName = `synthetic-${cv.key}-scanned.pdf`;
    fs.writeFileSync(path.join(outDir, scannedName), bytes);
    manifest.files.push({
      filename: scannedName,
      layout: 'scanned',
      lang: cv.lang,
      source: 'synthetic',
    });
    console.log(`  wrote ${scannedName} (image-only / no text layer)`);
  }

  await browser.close();
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`\nwrote ${manifest.files.length} PDFs + manifest.json to ${outDir}`);
  console.log('next: pnpm eval:cv-input-quality   and   pnpm eval:extractors\n');
}

main().catch((err) => {
  console.error('\ngen-synthetic-cvs failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});

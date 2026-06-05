import {
  extractJobSlugs,
  extractJsonLdBlocks,
  htmlToText,
  normalizeLocation,
  parseDetailPage,
} from '../../../src/modules/jobs/crawl/itviec-parser';

describe('itviec-parser (pure)', () => {
  describe('extractJobSlugs', () => {
    it('finds job-detail slugs and dedupes, preserving order', () => {
      const html = `
        <a href="/it-jobs/senior-react-developer-acme-1234">A</a>
        <a href="/it-jobs/backend-engineer-nodejs-foo-5678?utm=x">B</a>
        <a href="/it-jobs/senior-react-developer-acme-1234">dup</a>
        <a href="/it-jobs/reactjs">category link — no trailing id, must NOT match</a>`;
      expect(extractJobSlugs(html)).toEqual([
        'senior-react-developer-acme-1234',
        'backend-engineer-nodejs-foo-5678',
      ]);
    });
  });

  describe('extractJsonLdBlocks', () => {
    it("parses SINGLE-quoted type attribute (ITviec's actual markup)", () => {
      const html = `<script type='application/ld+json'>{"@type":"JobPosting","title":"X"}</script>`;
      expect(extractJsonLdBlocks(html)).toEqual([{ '@type': 'JobPosting', title: 'X' }]);
    });

    it('skips malformed blocks without throwing', () => {
      const html = `<script type="application/ld+json">{broken</script>
        <script type="application/ld+json">{"ok":true}</script>`;
      expect(extractJsonLdBlocks(html)).toEqual([{ ok: true }]);
    });
  });

  describe('htmlToText', () => {
    it('keeps list/line structure and decodes entities', () => {
      const text = htmlToText(
        '<p>Y&ecirc;u c&#7847;u:</p><ul><li>React &amp; Redux</li><li>Git</li></ul>',
      );
      expect(text).toContain('- React & Redux');
      expect(text).toContain('- Git');
      expect(text).not.toContain('<li>');
    });
  });

  describe('normalizeLocation', () => {
    it.each([
      ['Quan 1', 'Hồ Chí Minh'],
      ['Thành phố Thủ Đức', 'Hồ Chí Minh'],
      ['Quận Cầu Giấy', 'Hà Nội'],
      ['Da Nang', 'Đà Nẵng'],
      ['Not Available', null],
      ['', null],
    ])('"%s" → %s', (input, expected) => {
      expect(normalizeLocation(input)).toBe(expected);
    });
  });

  describe('parseDetailPage', () => {
    const page = (overrides: Record<string, unknown> = {}): string => {
      const posting = {
        '@type': 'JobPosting',
        title: 'Senior Backend Developer (NodeJS)',
        hiringOrganization: { name: 'Acme Corp' },
        jobLocation: { address: { addressLocality: 'Quan 7' } },
        datePosted: '2026-06-01',
        validThrough: '2099-01-01',
        baseSalary: { currency: 'USD', value: {} },
        description:
          '<p>Build REST API with Node.js, NestJS, PostgreSQL. Use Docker and Git daily. ' +
          'Write unit tests with Jest. Deploy via CI/CD pipelines on AWS. ' +
          'Collaborate with frontend (React) and mobile teams in an Agile environment.</p>',
        ...overrides,
      };
      return `<html><script type='application/ld+json'>${JSON.stringify(posting)}</script></html>`;
    };

    it('parses an active posting (placeholder salary ignored)', () => {
      const p = parseDetailPage('slug-1234', 'https://itviec.com/it-jobs/slug-1234', page());
      expect(p).not.toBeNull();
      expect(p!.companyName).toBe('Acme Corp');
      expect(p!.location).toBe('Hồ Chí Minh');
      expect(p!.salaryMin).toBeNull(); // ITviec placeholder baseSalary must not be trusted
      expect(p!.descriptionText).toContain('Node.js');
    });

    it('rejects pages whose validThrough is in the past', () => {
      expect(parseDetailPage('s-1111', 'u', page({ validThrough: '2020-01-01' }))).toBeNull();
    });

    it('rejects "Job expired" pages and pages without JobPosting', () => {
      expect(parseDetailPage('s-2222', 'u', '<title>Job expired | ITviec</title>')).toBeNull();
      expect(parseDetailPage('s-3333', 'u', '<html><body>no schema</body></html>')).toBeNull();
    });

    it('keeps real salaries when min/max are populated', () => {
      const p = parseDetailPage(
        's-4444',
        'u',
        page({ baseSalary: { currency: 'USD', value: { minValue: 1500, maxValue: 2500 } } }),
      );
      expect(p!.salaryMin).toBe(1500);
      expect(p!.salaryMax).toBe(2500);
      expect(p!.currency).toBe('USD');
    });
  });
});

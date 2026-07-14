import { assessExtractionQuality } from './extraction-quality';
import { CanonicalCvDocument, emptyCanonicalCv } from '../types/canonical-cv';

/**
 * Golden cases for the deterministic extraction_quality signal. 0 LLM, 0 DB — CI-gated.
 * Proves: clean text (EN + VN-with-diacritics) → high/no flags; mojibake / OCR / thin / sparse →
 * the right confidence + the right machine flag; and that the result NEVER carries a score field.
 */
describe('assessExtractionQuality', () => {
  // A document rich enough that section_count is high (so confidence is driven by the TEXT signals).
  const richDoc = (): CanonicalCvDocument => ({
    ...emptyCanonicalCv('en'),
    contact: { name: 'Nguyen Van A', email: 'a@x.dev', phone: null, location: null, links: [] },
    summary: 'Backend developer with shipped projects.',
    education: [
      {
        school: 'HUST',
        degree: 'BSc',
        field: 'CS',
        start: '2019',
        end: '2023',
        gpa: null,
        highlights: [],
      },
    ],
    experience: [
      {
        org: 'FPT',
        role: 'BE Dev',
        start: '2023',
        end: 'Present',
        location: null,
        bullets: ['Built REST APIs'],
      },
    ],
    skills: { technical: ['Node.js', 'SQL'], soft: [], languages: [], tools: ['Docker'] },
  });

  // ~400 chars of clean, word-like text → char_count ≥ 200, wordlike_ratio high, 0 mojibake.
  const CLEAN_EN = (
    'Backend developer with four years building REST APIs and event-driven services for fintech ' +
    'teams. Designed PostgreSQL schemas, tuned slow queries, and shipped CI pipelines on Docker ' +
    'and Kubernetes. Led a small team and mentored two interns through their first production launch. '
  ).repeat(1);

  const CLEAN_VI = (
    'Lập trình viên backend với bốn năm kinh nghiệm xây dựng REST API và dịch vụ hướng sự kiện cho ' +
    'các đội ngũ fintech. Thiết kế cơ sở dữ liệu PostgreSQL, tối ưu truy vấn chậm và triển khai CI ' +
    'trên Docker. Dẫn dắt một nhóm nhỏ và hướng dẫn hai thực tập sinh tới lần phát hành đầu tiên. '
  ).repeat(1);

  it('clean English text + rich document → confidence high, no flags', () => {
    const q = assessExtractionQuality(CLEAN_EN, richDoc());
    expect(q.confidence).toBe('high');
    expect(q.flags).toEqual([]);
    expect(q.mojibake_count).toBe(0);
    expect(q.char_count).toBeGreaterThan(200);
  });

  it('clean Vietnamese text WITH diacritics → confidence high (diacritics are NOT mojibake)', () => {
    const q = assessExtractionQuality(CLEAN_VI, richDoc());
    expect(q.confidence).toBe('high');
    expect(q.flags).toEqual([]);
    expect(q.mojibake_count).toBe(0);
  });

  it('mojibake-heavy text → confidence low + MOJIBAKE_HIGH flag', () => {
    // U+FFFD replacement chars are the unambiguous mojibake marker (each counts once).
    const garbled = CLEAN_EN + ' � � � � � � � � � � � �';
    const q = assessExtractionQuality(garbled, richDoc());
    expect(q.mojibake_count).toBe(12);
    expect(q.mojibake_ratio).toBeGreaterThan(0.02);
    expect(q.confidence).toBe('low');
    expect(q.flags).toContain('MOJIBAKE_HIGH');
  });

  it('OCR-sourced text → confidence low + OCR_USED flag (even when the text itself is clean)', () => {
    const q = assessExtractionQuality(CLEAN_EN, richDoc(), { ocrUsed: true });
    expect(q.ocr_used).toBe(true);
    expect(q.confidence).toBe('low');
    expect(q.flags).toContain('OCR_USED');
  });

  it('thin content (< 200 chars) → confidence low + THIN_CONTENT flag', () => {
    const q = assessExtractionQuality('Nguyen Van A. Backend dev. Node.js, SQL.', richDoc());
    expect(q.char_count).toBeLessThan(200);
    expect(q.confidence).toBe('low');
    expect(q.flags).toContain('THIN_CONTENT');
  });

  it('slight mojibake in otherwise clean text → confidence medium + MOJIBAKE_SLIGHT flag', () => {
    // 2 mojibake markers over ~290 clean chars → ratio in (0.005, 0.02] → medium, not low.
    const q = assessExtractionQuality(CLEAN_EN + ' � �', richDoc());
    expect(q.mojibake_count).toBe(2);
    expect(q.mojibake_ratio).toBeGreaterThan(0.005);
    expect(q.mojibake_ratio).toBeLessThanOrEqual(0.02);
    expect(q.confidence).toBe('medium');
    expect(q.flags).toContain('MOJIBAKE_SLIGHT');
  });

  it('clean text but a sparse document (< 3 sections) → confidence medium + SPARSE_SECTIONS flag', () => {
    const sparse: CanonicalCvDocument = {
      ...emptyCanonicalCv('en'),
      summary: 'Backend developer.',
      skills: { technical: ['Node.js'], soft: [], languages: [], tools: [] },
    };
    const q = assessExtractionQuality(CLEAN_EN, sparse);
    expect(q.section_count).toBeLessThan(3);
    expect(q.confidence).toBe('medium');
    expect(q.flags).toContain('SPARSE_SECTIONS');
    // emptyCanonicalCv has no contact → the parse-failure proxy also fires here.
    expect(q.flags).toContain('NO_CONTACT_ANCHOR');
  });

  it('clean text + rich doc but NO name AND NO email → confidence medium + NO_CONTACT_ANCHOR (parse-failure proxy)', () => {
    const doc = richDoc();
    doc.contact = { name: null, email: null, phone: '0900', location: null, links: [] };
    const q = assessExtractionQuality(CLEAN_EN, doc);
    expect(q.flags).toContain('NO_CONTACT_ANCHOR');
    expect(q.confidence).toBe('medium');
  });

  it('a name OR an email present → NO_CONTACT_ANCHOR does NOT fire', () => {
    const doc = richDoc();
    doc.contact = { name: null, email: 'a@x.dev', phone: null, location: null, links: [] };
    const q = assessExtractionQuality(CLEAN_EN, doc);
    expect(q.flags).not.toContain('NO_CONTACT_ANCHOR');
  });

  it('skill_count falls back to declared skills when no scan is provided', () => {
    const q = assessExtractionQuality(CLEAN_EN, richDoc());
    // richDoc declares Node.js + SQL + Docker = 3 declared skills.
    expect(q.skill_count).toBe(3);
  });

  it('uses the injected scan for skill_count when provided', () => {
    const scan = () => [
      { canonical_name: 'react' },
      { canonical_name: 'react' },
      { canonical_name: 'node_js' },
    ];
    const q = assessExtractionQuality(CLEAN_EN, richDoc(), { scan });
    expect(q.skill_count).toBe(2); // distinct canonicals
  });

  it('result is a pure signal — it never carries a score field', () => {
    const q = assessExtractionQuality(CLEAN_EN, richDoc());
    expect(Object.keys(q)).not.toContain('overall_score');
    expect(Object.keys(q)).not.toContain('score');
  });

  // TRUST' T1: input_quality is the 3-state trust verdict FE gates the score on. unusable requires
  // MULTIPLE hard signals to agree (a single low-confidence signal is only "suspect"); a missing
  // contact anchor is a supporting signal that can never, by itself, make a CV unusable.
  describe('input_quality (3-state)', () => {
    it('clean CV → usable', () => {
      expect(assessExtractionQuality(CLEAN_EN, richDoc()).input_quality).toBe('usable');
    });

    it('a single hard signal (OCR on clean text) → suspect, not unusable', () => {
      const q = assessExtractionQuality(CLEAN_EN, richDoc(), { ocrUsed: true });
      expect(q.confidence).toBe('low');
      expect(q.input_quality).toBe('suspect');
    });

    it('a single hard signal (thin content) → suspect', () => {
      const q = assessExtractionQuality('Nguyen Van A. Backend dev. Node.js, SQL.', richDoc());
      expect(q.flags).toContain('THIN_CONTENT');
      expect(q.input_quality).toBe('suspect');
    });

    it('TWO+ hard signals agree (OCR + thin garbage) → unusable', () => {
      const q = assessExtractionQuality('a b c', richDoc(), { ocrUsed: true });
      expect(q.flags).toEqual(expect.arrayContaining(['OCR_USED', 'THIN_CONTENT']));
      expect(q.input_quality).toBe('unusable');
    });

    it('mojibake-heavy OCR (mojibake_high + ocr) → unusable', () => {
      const garbled = 'x � � � � � � � � y'.repeat(1);
      const q = assessExtractionQuality(garbled, richDoc(), { ocrUsed: true });
      expect(q.input_quality).toBe('unusable');
    });

    it('missing name AND email ALONE (clean text) → suspect, never unusable', () => {
      const doc = richDoc();
      doc.contact = { name: null, email: null, phone: '0900', location: null, links: [] };
      const q = assessExtractionQuality(CLEAN_EN, doc);
      expect(q.flags).toContain('NO_CONTACT_ANCHOR');
      expect(q.input_quality).toBe('suspect');
    });

    it('a supporting-only signal (sparse sections, contact present) → suspect', () => {
      // contact + summary = 2 non-empty sections (< 3) → SPARSE_SECTIONS only; contact present so
      // NO_CONTACT_ANCHOR does NOT fire → the sole flag is a supporting one → suspect (not usable).
      const sparse: CanonicalCvDocument = {
        ...emptyCanonicalCv('en'),
        contact: { name: 'A', email: 'a@x.dev', phone: null, location: null, links: [] },
        summary: 'Backend developer.',
      };
      const q = assessExtractionQuality(CLEAN_EN, sparse);
      expect(q.flags).toEqual(['SPARSE_SECTIONS']);
      expect(q.input_quality).toBe('suspect');
    });
  });
});

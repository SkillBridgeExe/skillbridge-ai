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
});

import { buildCvBuilderFacts } from './cv-builder-chat.facts';
import type { CvBuilderDiagnosisBlock } from './cv-builder-diagnosis';
import { emptyCanonicalCv } from '../../common/types/canonical-cv';

describe('buildCvBuilderFacts', () => {
  it('surfaces the focused field (opaque field_path echo, HTML stripped) with detected gaps', () => {
    const doc = emptyCanonicalCv('vi');
    doc.projects = [
      { name: 'Web bán hàng', role: null, tech: [], bullets: ['Làm web bán hàng'], link: null },
    ];
    const facts = buildCvBuilderFacts(
      doc,
      { field_path: 'projects[0].description', current_value: '<p>Làm web bán hàng</p>' },
      'Data Analyst',
    );
    expect(facts.target_role).toBe('Data Analyst');
    expect(facts.cv_language).toBe('vi');
    expect(facts.focus?.section).toBe('projects');
    expect(facts.focus?.field_path).toBe('projects[0].description');
    expect(facts.focus?.current_text).toBe('Làm web bán hàng');
    expect(facts.focus?.gaps).toEqual(expect.arrayContaining(['result']));
    // No diagnosis arg → the facts declare a null block (the field is always present).
    expect(facts.diagnosis).toBeNull();
  });

  it('no focused field → focus null, but the sections inventory is still built', () => {
    const facts = buildCvBuilderFacts(emptyCanonicalCv('en'), null, null);
    expect(facts.focus).toBeNull();
    expect(facts.sections.length).toBeGreaterThan(0);
    expect(facts.diagnosis).toBeNull();
  });

  it('carries the diagnosis block through verbatim when one is passed', () => {
    const diagnosis: CvBuilderDiagnosisBlock = {
      prioritized_actions: ['Thêm kết quả đo được'],
      dimension_notes: [{ dimension: 'experience', note: 'mô tả chung chung' }],
      bullet_notes: [{ excerpt: 'Làm web bán hàng', tips: ['Mở đầu bằng động từ hành động'] }],
    };
    const facts = buildCvBuilderFacts(emptyCanonicalCv('vi'), null, 'Data Analyst', diagnosis);
    expect(facts.diagnosis).toBe(diagnosis);
  });

  it('unsupported section prefix → focus null (fail-closed)', () => {
    const facts = buildCvBuilderFacts(
      emptyCanonicalCv('vi'),
      { field_path: 'education[0].highlights', current_value: 'x' },
      null,
    );
    expect(facts.focus).toBeNull();
  });
});

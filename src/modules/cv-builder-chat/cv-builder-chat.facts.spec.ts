import { buildCvBuilderFacts } from './cv-builder-chat.facts';
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
  });

  it('no focused field → focus null, but the sections inventory is still built', () => {
    const facts = buildCvBuilderFacts(emptyCanonicalCv('en'), null, null);
    expect(facts.focus).toBeNull();
    expect(facts.sections.length).toBeGreaterThan(0);
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

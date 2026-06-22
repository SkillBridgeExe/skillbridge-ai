// test/modules/cv-intake/cv-intake.spec.ts
import { assembleExtraction } from '../../../src/modules/cv-intake/cv-intake';
const N =
  'Tôi làm ở SmartAI Solutions vị trí AI Engineer từ 05/2023 tới nay, xây chatbot bằng GPT-4o.';
describe('assembleExtraction', () => {
  it('keeps grounded fields, fills dates deterministically, flags missing', () => {
    const out = assembleExtraction(N, {
      fields: {
        company: { value: 'SmartAI Solutions', source_span: 'ở SmartAI Solutions' },
        position: { value: 'AI Engineer', source_span: 'vị trí AI Engineer' },
        description: {
          value: ['Xây chatbot bằng GPT-4o.'],
          source_span: 'xây chatbot bằng GPT-4o',
        },
      },
    });
    expect(out.fields.company.found).toBe(true);
    expect(out.fields.start.value).toBe('05/2023');
    expect(out.fields.end.found).toBe(false); // ongoing → end is "present"/missing per design
    expect(out.missing).toContain('achievements');
  });
  it('drops a fabricated company to missing (not in narrative)', () => {
    const out = assembleExtraction(N, {
      fields: { company: { value: 'Google', source_span: '' } },
    });
    expect(out.fields.company.found).toBe(false);
    expect(out.missing).toContain('company');
  });
});

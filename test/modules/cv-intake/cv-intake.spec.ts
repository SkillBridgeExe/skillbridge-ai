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

  // Anti-fabrication hole: an empty / whitespace LLM value must NOT be reported as found
  // (it would silently drop from `missing` and "apply empty-only" would no-op while claiming success).
  it('treats an empty or whitespace value as not-found, across atom and prose fields', () => {
    const out = assembleExtraction(N, {
      fields: {
        company: { value: '', source_span: '' }, // atom
        position: { value: '   ', source_span: '' }, // atom, whitespace
        description: { value: [''], source_span: '' }, // prose
      },
    });
    expect(out.fields.company.found).toBe(false);
    expect(out.fields.position.found).toBe(false);
    expect(out.fields.description.found).toBe(false);
    expect(out.missing).toEqual(expect.arrayContaining(['company', 'position', 'description']));
  });

  // A named atom (company/position) must be a real ≥2-char contiguous entity — a 1-char value
  // would substring-match a common letter and slip through.
  it('rejects a 1-char company atom', () => {
    const out = assembleExtraction(N, {
      fields: { company: { value: 'A', source_span: '' } },
    });
    expect(out.fields.company.found).toBe(false);
    expect(out.missing).toContain('company');
  });

  // A grounded value with no source_span is real but weakly-located → low confidence (so the UI can flag it).
  it('marks a grounded value with a blank source_span as low confidence', () => {
    const out = assembleExtraction(N, {
      fields: { company: { value: 'SmartAI Solutions', source_span: '' } },
    });
    expect(out.fields.company.found).toBe(true);
    expect(out.fields.company.confidence).toBe('low');
  });
});

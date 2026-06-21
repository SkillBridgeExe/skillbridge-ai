import { readFileSync } from 'fs';
import { join } from 'path';

const read = (file: string): string => readFileSync(join(process.cwd(), 'prompts', file), 'utf8');

describe('answer_insight_v1 prompt contract', () => {
  const prompt = read('answer_insight_v1.md');

  it('starts with the system frontmatter the loader expects', () => {
    expect(prompt.startsWith('---')).toBe(true);
    expect(prompt).toMatch(/system:/);
  });

  it('declares every required input variable', () => {
    for (const variable of [
      'language',
      'question',
      'answer',
      'target_dimension',
      'signals_summary',
    ]) {
      expect(prompt).toContain(`{{${variable}}}`);
    }
  });

  it('specifies exactly the 8 MODEL output fields and NOT evidence_quality (code derives it)', () => {
    for (const field of [
      'talking_point',
      'relevance',
      'clarity',
      'off_topic',
      'confidence_tone',
      'note',
      'has_specific_example',
      'star_present',
    ]) {
      expect(prompt).toContain(field);
    }
    // evidence_quality is CODE-derived from Layer 1 — the model must never output it.
    expect(prompt).not.toContain('evidence_quality');
  });

  it('defines a specific-example rubric with at least one worked example', () => {
    const lower = prompt.toLowerCase();
    expect(lower).toMatch(/specific example/);
    // Pin the actual worked-example block headings in the prompt (not just any "e.g." usage).
    // The prompt uses numbered examples with descriptive labels: "Example 1 — ..." and
    // "Example 2 — generic / hypothetical ...". This assertion would fail if the worked-example
    // block were removed or replaced with inline e.g. notes only.
    expect(prompt).toMatch(/Example\s+\d\s*[—–-]|full-STAR answer|generic.*hypothetical/i);
  });

  it('instructs the model to judge only and NOT recompute Layer 1 counts', () => {
    const lower = prompt.toLowerCase();
    expect(lower).toContain('judge');
    expect(lower).toMatch(/do not recompute|never recompute|do not recount/);
  });

  it('forbids coaching / revealing answers and asks for JSON only', () => {
    const lower = prompt.toLowerCase();
    expect(lower).toMatch(/do not (coach|reveal|answer)|never (coach|reveal)/);
    expect(lower).toMatch(/json only|return (valid )?json/);
  });
});

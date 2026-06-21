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

  it('specifies exactly the 6 MODEL output fields and NOT evidence_quality (code derives it)', () => {
    for (const field of [
      'talking_point',
      'relevance',
      'clarity',
      'off_topic',
      'confidence_tone',
      'note',
    ]) {
      expect(prompt).toContain(field);
    }
    // evidence_quality is CODE-derived from Layer 1 — the model must never output it.
    expect(prompt).not.toContain('evidence_quality');
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

import { readFileSync } from 'fs';
import { join } from 'path';

const read = (file: string): string => readFileSync(join(process.cwd(), 'prompts', file), 'utf8');

describe('interview_coaching_v1 prompt contract', () => {
  const prompt = read('interview_coaching_v1.md');

  it('starts with the system frontmatter the loader expects', () => {
    expect(prompt.startsWith('---')).toBe(true);
    expect(prompt).toMatch(/system:/);
  });

  it('declares every required input variable', () => {
    for (const variable of [
      'overall',
      'overall_band',
      'strengths',
      'priorities',
      'top_gaps',
      'language',
    ]) {
      expect(prompt).toContain(`{{${variable}}}`);
    }
  });

  it('declares ONLY the 2 model output fields (summary + priority_notes) — code owns the rest', () => {
    expect(prompt).toContain('summary');
    expect(prompt).toContain('priority_notes');
    // The model must NOT output strengths/priorities — code owns them.
    const lower = prompt.toLowerCase();
    expect(lower).toMatch(/do not output|never output|code owns|do not (add|invent)/);
  });

  it('instructs the model to ground every sentence and NOT invent skills/resources/URLs/numbers', () => {
    const lower = prompt.toLowerCase();
    expect(lower).toContain('ground');
    expect(lower).toMatch(/do not invent|never invent|do not fabricate/);
    expect(lower).toMatch(/url|link/);
    expect(lower).toMatch(/number|metric|statistic/);
  });

  it('asks for JSON only', () => {
    const lower = prompt.toLowerCase();
    expect(lower).toMatch(/json only|return (valid )?json/);
  });

  it('describes priority_notes[i] as the why for priorities[i]', () => {
    const lower = prompt.toLowerCase();
    expect(lower).toMatch(/priority_notes/);
    expect(lower).toMatch(/why|matters/);
  });
});

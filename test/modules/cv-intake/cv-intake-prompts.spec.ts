import { readFileSync } from 'fs';
import { join } from 'path';

const read = (file: string): string => readFileSync(join(process.cwd(), 'prompts', file), 'utf8');

describe('cv_intake_experience_v1 prompt contract', () => {
  const prompt = read('cv_intake_experience_v1.md');

  it('starts with the system frontmatter the loader expects', () => {
    expect(prompt.startsWith('---')).toBe(true);
    expect(prompt).toMatch(/system:/);
  });

  it('declares every required input variable', () => {
    for (const variable of ['narrative', 'output_lang']) {
      expect(prompt).toContain(`{{${variable}}}`);
    }
  });

  it('asks for JSON only', () => {
    expect(prompt.toLowerCase()).toMatch(/json only/);
  });

  it('forbids inventing facts — only what the story states', () => {
    const lower = prompt.toLowerCase();
    expect(lower).toMatch(/do not invent|only what the story states|never invent|never guess/);
  });

  it('asks for a source_span per field', () => {
    expect(prompt).toContain('source_span');
  });
});

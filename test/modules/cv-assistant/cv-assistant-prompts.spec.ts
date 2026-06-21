import { readFileSync } from 'fs';
import { join } from 'path';

const read = (file: string): string => readFileSync(join(process.cwd(), 'prompts', file), 'utf8');

describe('cv_assistant_rewrite_v1 prompt contract', () => {
  const prompt = read('cv_assistant_rewrite_v1.md');

  it('starts with the system frontmatter the loader expects', () => {
    expect(prompt.startsWith('---')).toBe(true);
    expect(prompt).toMatch(/system:/);
  });

  it('declares every required input variable', () => {
    for (const variable of ['language', 'before', 'facts']) {
      expect(prompt).toContain(`{{${variable}}}`);
    }
  });

  it('outputs exactly after + used_facts and asks for JSON only', () => {
    expect(prompt).toContain('after');
    expect(prompt).toContain('used_facts');
    expect(prompt.toLowerCase()).toMatch(/json only/);
  });

  it('forbids fabrication and coaching', () => {
    const lower = prompt.toLowerCase();
    expect(lower).toMatch(/never invent|do not introduce|anti-fabrication|not in the facts/);
    expect(lower).toMatch(/do not coach|never coach/);
  });
});

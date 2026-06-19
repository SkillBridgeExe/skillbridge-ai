import { readFileSync } from 'fs';
import { join } from 'path';

const read = (f: string): string => readFileSync(join(process.cwd(), 'prompts', f), 'utf8');

describe('roadmap_v2 prompt contract', () => {
  const p = read('roadmap_v2.md');

  it('starts with the system frontmatter the loader expects', () => {
    expect(p.startsWith('---')).toBe(true);
    expect(p).toMatch(/system:/);
  });

  it('declares every required input variable', () => {
    for (const v of ['language', 'roadmap']) expect(p).toContain(`{{${v}}}`);
  });

  it('specifies the narrative output fields', () => {
    for (const f of [
      'ai_summary',
      'step_narratives',
      'skill_canonical',
      'why',
      'what_to_produce',
      'not_feasible_explanation',
    ]) {
      expect(p).toContain(f);
    }
  });

  it('enforces narrative-only + anti-fabrication guards', () => {
    const low = p.toLowerCase();
    expect(low).toMatch(/narrative only/);
    expect(low).toMatch(/do not (add|invent)/);
    expect(low).toContain('proof_of_completion'); // what_to_produce is tied to it
  });
});

describe('learning_chat_v1 prompt contract', () => {
  const p = read('learning_chat_v1.md');

  it('starts with the system frontmatter', () => {
    expect(p.startsWith('---')).toBe(true);
    expect(p).toMatch(/system:/);
  });

  it('declares every required input variable', () => {
    for (const v of ['language', 'user_context', 'resources', 'history', 'question']) {
      expect(p).toContain(`{{${v}}}`);
    }
  });

  it('specifies the output fields', () => {
    for (const f of ['message', 'cited_resource_ids', 'suggested_next_step'])
      expect(p).toContain(f);
  });

  it('enforces cite-by-resource_id-only + no-fabrication + honest empty-state', () => {
    const low = p.toLowerCase();
    expect(low).toContain('resource_id');
    expect(low).toMatch(/do not (invent|fabricate)/);
    expect(low).toMatch(/honest|empty/);
    expect(low).toMatch(/never write a raw url|do not .*url/);
  });
});

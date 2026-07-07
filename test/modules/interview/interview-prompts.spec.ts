import { readFileSync } from 'fs';
import { join } from 'path';

const read = (file: string): string => readFileSync(join(process.cwd(), 'prompts', file), 'utf8');

describe('interview_assess_v1 prompt contract', () => {
  const prompt = read('interview_assess_v1.md');

  it('starts with the system frontmatter the loader expects', () => {
    expect(prompt.startsWith('---')).toBe(true);
    expect(prompt).toMatch(/system:/);
  });

  it('declares every required input variable', () => {
    for (const variable of [
      'current_topic',
      'current_thread',
      'recent_qa',
      'drill_depth',
      'language',
      'seniority_target',
      'target_dimension',
    ]) {
      expect(prompt).toContain(`{{${variable}}}`);
    }
  });

  it('specifies the assessment output fields and no-question behavior', () => {
    for (const field of [
      'score',
      'recognized_concepts',
      'depth_signal',
      'claim_status',
      'current_thread',
      'gaps_revealed',
      'note',
    ]) {
      expect(prompt).toContain(field);
    }
    expect(prompt.toLowerCase()).toMatch(/assess only|do not (ask|write).*question/);
  });
});

describe('interview_ask_v1 prompt contract', () => {
  const prompt = read('interview_ask_v1.md');

  it('starts with the system frontmatter', () => {
    expect(prompt.startsWith('---')).toBe(true);
    expect(prompt).toMatch(/system:/);
  });

  it('declares every required input variable', () => {
    for (const variable of [
      'decision',
      'current_topic',
      'current_thread',
      'recent_qa',
      'running_notes',
      'seniority_target',
      'language',
      'language_instruction',
      'prev_topic_outcome',
    ]) {
      expect(prompt).toContain(`{{${variable}}}`);
    }
  });

  it('specifies the output fields and per-decision behavior', () => {
    for (const field of ['ai_message', 'question']) expect(prompt).toContain(field);
    for (const decision of ['drill', 'push_harder', 'advance', 'wrap', 'opener']) {
      expect(prompt.toLowerCase()).toContain(decision);
    }
  });

  it('locks language and field-separation rules to prevent mixed-language double questions', () => {
    const lower = prompt.toLowerCase();

    expect(prompt).toContain('{{language_instruction}}');
    expect(lower).toContain('ai_message must not contain a question');
    expect(lower).toContain(
      'question is the only field that may contain the official interview question',
    );
    expect(lower).toMatch(/do not return.*english.*vietnamese|do not return.*vietnamese.*english/);
  });
});

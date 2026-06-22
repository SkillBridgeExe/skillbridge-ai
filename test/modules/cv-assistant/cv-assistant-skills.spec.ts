import { analyzeSkillsSection } from '../../../src/modules/cv-assistant/cv-assistant-skills';

describe('analyzeSkillsSection — completeness nudge (deterministic, no fabrication)', () => {
  it('flags too few technical + no tools + no languages', () => {
    const nudges = analyzeSkillsSection({ technical: ['React'], tools: [], languages: [] }, 'en');
    expect(nudges.map((n) => n.code)).toEqual(['too_few_technical', 'no_tools', 'no_languages']);
  });

  it('a complete skills section → NO nudges', () => {
    const nudges = analyzeSkillsSection(
      {
        technical: ['React', 'Node.js', 'SQL', 'Docker'],
        tools: ['Git'],
        languages: ['English'],
      },
      'en',
    );
    expect(nudges).toEqual([]);
  });

  it('never invents a skill — the too-few message reports the COUNT, not an invented skill', () => {
    const nudges = analyzeSkillsSection(
      { technical: [], tools: ['Git'], languages: ['English'] },
      'en',
    );
    expect(nudges).toHaveLength(1);
    expect(nudges[0].code).toBe('too_few_technical');
    expect(nudges[0].message).toContain('0');
  });

  it('is bilingual', () => {
    const nudges = analyzeSkillsSection({ technical: [], tools: [], languages: [] }, 'vi');
    expect(nudges[0].message).toMatch(/kỹ năng/);
  });

  it('treats missing categories as empty (undefined-safe)', () => {
    const nudges = analyzeSkillsSection({}, 'en');
    expect(nudges.map((n) => n.code)).toEqual(['too_few_technical', 'no_tools', 'no_languages']);
  });
});

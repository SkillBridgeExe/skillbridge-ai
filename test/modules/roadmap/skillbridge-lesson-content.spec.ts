import {
  SKILLBRIDGE_LESSON_SKILLS,
  getSkillBridgeLessonContent,
} from '../../../src/modules/roadmap/skillbridge-lesson-content';

const INTERNAL_SKILLS = [
  'react',
  'typescript',
  'javascript',
  'node_js',
  'dotnet',
  'java',
  'spring_boot',
  'python',
  'sql',
  'postgresql',
  'docker',
  'git',
  'rest_api',
  'html',
  'css',
  'english_proficiency',
  'communication',
  'cv_writing',
  'system_design',
  'llm_engineering',
] as const;

describe('SkillBridge lesson content catalog', () => {
  it('provides full SkillBridge-owned lesson content for every internal ladder skill', () => {
    expect(SKILLBRIDGE_LESSON_SKILLS).toEqual([...INTERNAL_SKILLS]);

    for (const skill of INTERNAL_SKILLS) {
      const lesson = getSkillBridgeLessonContent(skill, [`resource-${skill}`]);

      expect(lesson).toBeDefined();
      expect(lesson).toMatchObject({
        skill_canonical: skill,
        license_type: 'skillbridge_original',
        reuse_policy: 'full_reuse_allowed',
        source_resource_ids: [`resource-${skill}`],
      });
      expect(lesson?.summary.length).toBeGreaterThan(40);
      expect(lesson?.sections).toHaveLength(2);
      expect(lesson?.sections.every((section) => section.body.length > 60)).toBe(true);
      expect(lesson?.sections.every((section) => section.checklist.length >= 3)).toBe(true);
      expect(lesson?.quiz).toHaveLength(2);
      expect(lesson?.quiz.every((question) => question.options.length === 4)).toBe(true);
      expect(lesson?.exercises).toHaveLength(1);
      expect(lesson?.exercises[0].acceptance_criteria.length).toBeGreaterThanOrEqual(3);
      expect(lesson?.exercises[0].proof_of_completion.length).toBeGreaterThan(20);
    }
  });
});

import { StoryExtractionService } from './story-extraction.service';
import { SkillTaxonomyService } from '../../common/services/skill-taxonomy.service';

function buildSvc(llmProjects: unknown, throwLlm = false) {
  const taxonomy = new SkillTaxonomyService();
  (taxonomy as unknown as { onModuleInit: () => void }).onModuleInit();
  const llm = {
    complete: jest.fn().mockImplementation(() => {
      if (throwLlm) throw new Error('llm down');
      return Promise.resolve({ parsedJson: { projects: llmProjects } });
    }),
  };
  const prompts = {
    get: () => ({ code: 'cv_story_project', version: 1, meta: { system: 'x' } }),
    render: () => 'rendered',
  };
  const tracing = {
    startAiRequest: jest.fn().mockResolvedValue('rid'),
    completeAiRequest: jest.fn(),
    markFailed: jest.fn(),
  };
  return new StoryExtractionService(llm as never, prompts as never, taxonomy, tracing as never);
}

describe('StoryExtractionService', () => {
  const story = 'Dự án Shop Online bằng React và Node.js, nhóm 4 người. Có chứng chỉ TOEIC 2022.';

  it('returns grounded projects + certs, not degraded', async () => {
    const svc = buildSvc([
      { name: 'Shop Online', description: 'Dự án Shop Online bằng React và Node.js' },
    ]);
    const r = await svc.extract(story, 'vi', 'user-1');
    expect(r.degraded).toBe(false);
    expect(r.projects[0].name).toBe('Shop Online');
    expect(r.certifications.some((c) => c.matched_pattern === 'toeic')).toBe(true);
  });

  it('degrades (projects:[]) but still returns certs when the LLM throws', async () => {
    const svc = buildSvc([], true);
    const r = await svc.extract(story, 'vi', 'user-1');
    expect(r.degraded).toBe(true);
    expect(r.projects).toEqual([]);
    // certs are pure-code, independent of the LLM
    expect(r.certifications.some((c) => c.matched_pattern === 'toeic')).toBe(true);
  });
});

import { StoryExtractionService } from './story-extraction.service';
import { SkillTaxonomyService } from '../../common/services/skill-taxonomy.service';

const REAL_PROMPT_CODE = 'cv_story_project_v1';

function buildSvc(parsedJson: unknown, throwLlm = false) {
  const taxonomy = new SkillTaxonomyService();
  (taxonomy as unknown as { onModuleInit: () => void }).onModuleInit();
  const llm = {
    complete: jest.fn().mockImplementation(() => {
      if (throwLlm) throw new Error('llm down');
      // Shorthand: a bare array of proposed projects is wrapped as `{ projects }`; anything else
      // (already-shaped object, {}, null) is passed through unchanged for the pre-existing tests.
      const payload = Array.isArray(parsedJson) ? { projects: parsedJson } : parsedJson;
      return Promise.resolve({ parsedJson: payload });
    }),
  };
  // Faithful to PromptsService.get(): throws (like the real NotFoundException) for any code
  // other than the real combined `<code>_v<version>` key, and returns the real template shape
  // ({ code, version, filename, body, meta }) otherwise — so a wrong PROMPT_CODE fails like prod.
  const prompts = {
    get: (code: string) => {
      if (code !== REAL_PROMPT_CODE) throw new Error(`Prompt template not found: ${code}`);
      return {
        code: 'cv_story_project',
        version: 1,
        filename: 'cv_story_project_v1.md',
        body: '{{narrative}}',
        meta: { system: 'x' },
      };
    },
    render: () => 'rendered',
  };
  const tracing = {
    startAiRequest: jest.fn().mockResolvedValue('rid'),
    completeAiRequest: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
  };
  return new StoryExtractionService(llm as never, prompts as never, taxonomy, tracing as never);
}

describe('StoryExtractionService', () => {
  const story = 'Dự án Shop Online bằng React và Node.js, nhóm 4 người. Có chứng chỉ TOEIC 2022.';

  it('returns grounded projects + certs, not degraded', async () => {
    const svc = buildSvc({
      projects: [{ name: 'Shop Online', description: 'Dự án Shop Online bằng React và Node.js' }],
    });
    const r = await svc.extract(story, 'vi', 'user-1');
    expect(r.degraded).toBe(false);
    expect(r.projects[0].name).toBe('Shop Online');
    expect(r.certifications.some((c) => c.matched_pattern === 'toeic')).toBe(true);
  });

  it('degrades (projects:[]) but still returns certs when the LLM throws', async () => {
    const svc = buildSvc({ projects: [] }, true);
    const r = await svc.extract(story, 'vi', 'user-1');
    expect(r.degraded).toBe(true);
    expect(r.projects).toEqual([]);
    // certs are pure-code, independent of the LLM
    expect(r.certifications.some((c) => c.matched_pattern === 'toeic')).toBe(true);
  });

  it('degrades on malformed/absent parsedJson (not "honestly zero projects")', async () => {
    const svc = buildSvc(null);
    const r = await svc.extract(story, 'vi', 'user-1');
    expect(r.degraded).toBe(true);
    expect(r.projects).toEqual([]);
    expect(r.certifications.some((c) => c.matched_pattern === 'toeic')).toBe(true);
  });

  it('degrades when parsedJson.projects is missing/mistyped', async () => {
    const svc = buildSvc({});
    const r = await svc.extract(story, 'vi', 'user-1');
    expect(r.degraded).toBe(true);
    expect(r.projects).toEqual([]);
  });
});

describe('StoryExtractionService.extractProject', () => {
  it('returns the single grounded project (not degraded, not multiple)', async () => {
    const svc = buildSvc([
      { name: 'Shop Online', description: 'Dự án Shop Online bằng React và Node.js' },
    ]);
    const r = await svc.extractProject('Dự án Shop Online bằng React và Node.js.', 'vi', 'user-1');
    expect(r.degraded).toBe(false);
    expect(r.multipleDetected).toBe(false);
    expect(r.project?.name).toBe('Shop Online');
  });

  it('fills the FIRST grounded project and flags multipleDetected when the story has 2', async () => {
    const svc = buildSvc([
      { name: 'Shop Online', description: 'Dự án Shop Online bằng React' },
      { name: 'Chat App', description: 'Dự án Chat App bằng Node.js' },
    ]);
    const story = 'Dự án Shop Online bằng React. Dự án Chat App bằng Node.js.';
    const r = await svc.extractProject(story, 'vi', 'user-1');
    expect(r.project?.name).toBe('Shop Online');
    expect(r.multipleDetected).toBe(true);
  });

  it('degrades (project:null) when the LLM throws', async () => {
    const svc = buildSvc([], true); // throwLlm
    const r = await svc.extractProject('x', 'vi', 'user-1');
    expect(r.degraded).toBe(true);
    expect(r.project).toBeNull();
    expect(r.multipleDetected).toBe(false);
  });

  it('returns project:null when the proposed name is not grounded in the story (no fabrication)', async () => {
    const svc = buildSvc([{ name: 'Imaginary CRM', description: 'a CRM' }]);
    const r = await svc.extractProject('Tôi làm web với React.', 'vi', 'user-1');
    expect(r.project).toBeNull();
    expect(r.degraded).toBe(false); // honest "found nothing", not a failure
  });
});

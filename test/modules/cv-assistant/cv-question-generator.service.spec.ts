import { CvQuestionGeneratorService } from '../../../src/modules/cv-assistant/cv-question-generator.service';
import { CompanionContext } from '../../../src/modules/cv-assistant/cv-assistant';

function build() {
  const complete = jest.fn();
  const llm = { complete } as never;
  const prompts = {
    get: jest.fn(() => ({
      code: 'cv_assistant_questions_v1',
      version: 1,
      meta: { system: 'sys' },
    })),
    render: jest.fn(() => 'rendered user prompt'),
  } as never;
  const tracing = {
    startAiRequest: jest.fn().mockResolvedValue('req-1'),
    completeAiRequest: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
  } as never;
  const svc = new CvQuestionGeneratorService(llm, prompts, tracing);
  return { svc, llm: llm as unknown as { complete: jest.Mock } };
}

const CTX: CompanionContext = {
  page: 'cv_builder',
  section: 'projects',
  current_value: 'làm web bán hàng',
  locale: 'vi',
  target_role: 'backend_developer',
};

describe('CvQuestionGeneratorService.generate', () => {
  it('returns role-aware smart questions when the LLM succeeds', async () => {
    const { svc, llm } = build();
    llm.complete.mockResolvedValue({
      parsedJson: {
        already_strong: false,
        questions: [{ gap: 'tech', prompt: 'API bằng gì?', chips: ['Node', 'Spring'] }],
      },
      text: '{}',
      tokenUsage: {},
    });
    const turn = await svc.generate(CTX);
    expect(turn.questions.map((q) => q.gap)).toContain('tech');
    expect(turn.questions[0].options.map((o) => o.label)).toContain('Node');
  });

  it('falls back to the rule turn when the LLM throws (never throws)', async () => {
    const { svc, llm } = build();
    llm.complete.mockRejectedValue(new Error('down'));
    const turn = await svc.generate(CTX);
    expect(turn.questions.length).toBeGreaterThan(0); // rule chips, not empty
  });

  it('empty/strong value → no questions (already strong)', async () => {
    const { svc, llm } = build();
    llm.complete.mockResolvedValue({
      parsedJson: { already_strong: true, questions: [] },
      text: '{}',
      tokenUsage: {},
    });
    const turn = await svc.generate({
      page: 'cv_builder',
      section: 'projects',
      current_value: 'Built a React dashboard cutting load time',
      locale: 'en',
      target_role: 'frontend_developer',
    });
    expect(turn.questions).toHaveLength(0);
  });

  it('no target_role → stays role-blind, never calls the LLM', async () => {
    const { svc, llm } = build();
    const turn = await svc.generate({ ...CTX, target_role: undefined });
    expect(llm.complete).not.toHaveBeenCalled();
    expect(turn.questions.length).toBeGreaterThan(0); // rule chips
  });

  it('section this skill does not route (e.g. skills) → empty turn, never calls the LLM', async () => {
    const { svc, llm } = build();
    const turn = await svc.generate({ ...CTX, section: 'skills' });
    expect(llm.complete).not.toHaveBeenCalled();
    expect(turn.questions).toHaveLength(0);
  });
});

import { CvQuestionGeneratorService } from '../../../src/modules/cv-assistant/cv-question-generator.service';
import {
  CompanionContext,
  strongTurnMessage,
} from '../../../src/modules/cv-assistant/cv-assistant';

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
  return {
    svc,
    llm: llm as unknown as { complete: jest.Mock },
    prompts: prompts as unknown as { render: jest.Mock },
  };
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

  it('LLM says already_strong on a rule-WEAK bullet → no questions AND the STRONG message (not the rule WEAK fallback)', async () => {
    const { svc, llm } = build();
    llm.complete.mockResolvedValue({
      parsedJson: { already_strong: true, questions: [] },
      text: '{}',
      tokenUsage: {},
    });
    // CTX.current_value ('làm web bán hàng') is rule-WEAK (missing action/tech) so `generate` must
    // actually call the LLM here — proving the already_strong branch, not the gaps-empty shortcut.
    const turn = await svc.generate(CTX);
    expect(llm.complete).toHaveBeenCalled();
    expect(turn.questions).toHaveLength(0);
    expect(turn.message).toBe(strongTurnMessage(CTX.section, CTX.locale));
  });

  it('rule-strong bullet (gaps already empty) → returns before the LLM, never calls it', async () => {
    const { svc, llm } = build();
    const turn = await svc.generate({
      page: 'cv_builder',
      section: 'projects',
      current_value: 'Built a React dashboard cutting load time',
      locale: 'en',
      target_role: 'frontend_developer',
    });
    expect(llm.complete).not.toHaveBeenCalled();
    expect(turn.questions).toHaveLength(0);
  });

  it('no target_role → stays role-blind, never calls the LLM', async () => {
    const { svc, llm } = build();
    const turn = await svc.generate({ ...CTX, target_role: undefined });
    expect(llm.complete).not.toHaveBeenCalled();
    expect(turn.questions.length).toBeGreaterThan(0); // rule chips
  });

  it('honors requested_action when building the role-aware prompt gaps', async () => {
    const { svc, llm, prompts } = build();
    llm.complete.mockResolvedValue({
      parsedJson: {
        already_strong: false,
        questions: [{ gap: 'result', prompt: 'Kết quả thật là gì?', chips: ['Nhanh hơn'] }],
      },
      text: '{}',
      tokenUsage: {},
    });

    await svc.generate({
      ...CTX,
      current_value: 'Built a React dashboard.',
      requested_action: 'add_evidence',
    });

    expect(prompts.render).toHaveBeenCalledWith(
      'cv_assistant_questions_v1',
      expect.objectContaining({ gaps: 'result' }),
    );
  });

  it('section this skill does not route (e.g. skills) → empty turn, never calls the LLM', async () => {
    const { svc, llm } = build();
    const turn = await svc.generate({ ...CTX, section: 'skills' });
    expect(llm.complete).not.toHaveBeenCalled();
    expect(turn.questions).toHaveLength(0);
  });
});

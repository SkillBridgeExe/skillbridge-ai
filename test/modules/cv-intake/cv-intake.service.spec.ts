import { CvIntakeService } from '../../../src/modules/cv-intake/cv-intake.service';

function makeDeps(complete: jest.Mock) {
  const llm = { complete } as never;
  const prompts = {
    get: jest.fn(() => ({
      code: 'cv_intake_experience_v1',
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
  return { llm, prompts, tracing };
}

const llmOk = (parsedJson: unknown): jest.Mock =>
  jest.fn().mockResolvedValue({
    parsedJson,
    text: '',
    tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    estimatedCostUsd: 0,
    latencyMs: 1,
    modelCode: 'gpt-test',
  });

const N =
  'Tôi làm ở SmartAI Solutions vị trí AI Engineer từ 05/2023 tới nay, xây chatbot bằng GPT-4o.';

describe('CvIntakeService.extract', () => {
  it('keeps grounded fields and fills dates deterministically', async () => {
    const complete = llmOk({
      fields: {
        company: { value: 'SmartAI Solutions', source_span: 'ở SmartAI Solutions' },
        position: { value: 'AI Engineer', source_span: 'vị trí AI Engineer' },
        description: {
          value: ['Xây chatbot bằng GPT-4o.'],
          source_span: 'xây chatbot bằng GPT-4o',
        },
      },
    });
    const d = makeDeps(complete);
    const svc = new CvIntakeService(d.llm, d.prompts, d.tracing);
    const out = await svc.extract({
      section: 'experience',
      narrative: N,
      locale: 'vi',
      outputLang: 'vi',
    });
    expect(out.degraded).toBeFalsy();
    expect(out.fields.company.found).toBe(true);
    expect(out.fields.company.value).toBe('SmartAI Solutions');
    expect(out.fields.position.found).toBe(true);
    expect(out.fields.start.value).toBe('05/2023');
    expect(out.fields.start.found).toBe(true);
    expect(out.missing).toContain('achievements');
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('drops a fabricated company to missing (grounding gate)', async () => {
    const complete = llmOk({
      fields: {
        company: { value: 'Google', source_span: '' },
        position: { value: 'AI Engineer', source_span: 'vị trí AI Engineer' },
      },
    });
    const d = makeDeps(complete);
    const svc = new CvIntakeService(d.llm, d.prompts, d.tracing);
    const out = await svc.extract({
      section: 'experience',
      narrative: N,
      locale: 'vi',
      outputLang: 'vi',
    });
    expect(out.degraded).toBeFalsy();
    expect(out.fields.company.found).toBe(false);
    expect(out.missing).toContain('company');
  });

  it('degrades (never throws) when the LLM call fails', async () => {
    const complete = jest.fn().mockRejectedValue(new Error('llm down'));
    const d = makeDeps(complete);
    const svc = new CvIntakeService(d.llm, d.prompts, d.tracing);
    const out = await svc.extract({
      section: 'experience',
      narrative: N,
      locale: 'vi',
      outputLang: 'vi',
    });
    expect(out.degraded).toBe(true);
    expect(out.fields.company.found).toBe(false);
    expect(out.missing).toEqual(
      expect.arrayContaining([
        'company',
        'position',
        'start',
        'end',
        'description',
        'achievements',
      ]),
    );
  });

  it('degrades when the model output is unparseable (no fields object)', async () => {
    const complete = llmOk(null);
    const d = makeDeps(complete);
    const svc = new CvIntakeService(d.llm, d.prompts, d.tracing);
    const out = await svc.extract({
      section: 'experience',
      narrative: N,
      locale: 'vi',
      outputLang: 'vi',
    });
    expect(out.degraded).toBe(true);
    expect(out.missing.length).toBe(6);
  });

  it('renders the prompt in the requested output_lang and masks PII before the LLM sees it', async () => {
    const complete = llmOk({
      fields: { company: { value: 'SmartAI Solutions', source_span: 'ở SmartAI Solutions' } },
    });
    const d = makeDeps(complete);
    const svc = new CvIntakeService(d.llm, d.prompts, d.tracing);
    await svc.extract({
      section: 'experience',
      narrative: 'Tôi làm ở SmartAI Solutions, liên hệ toi@example.com.',
      locale: 'vi',
      outputLang: 'en', // CV-output language is independent of the UI locale
    });
    const renderArgs = (d.prompts as unknown as { render: jest.Mock }).render.mock.calls[0][1];
    expect(renderArgs.output_lang).toBe('en'); // intake threads output_lang to the prompt (parity with rewrite)
    expect(renderArgs.narrative).not.toContain('toi@example.com'); // PII never reaches the model
  });
});

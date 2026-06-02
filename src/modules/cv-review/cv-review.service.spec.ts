import { CvReviewService } from './cv-review.service';

/**
 * Focused unit spec for the R1 gap fix + composite math.
 * All collaborators are mocked — no real LLM call. Asserts:
 *   1. composite formula  overall = ats×0.4 + (llm_total/80×100)×0.6
 *   2. GAP A — the rubric prompt receives the STRUCTURED document (serialized)
 *   3. GAP B — the detected language is passed to the rubric prompt
 *   4. the auto-detected language is surfaced in the response
 */
describe('CvReviewService', () => {
  const document = {
    language: 'vi',
    contact: { name: 'Nguyen A', email: null, phone: null, location: null, links: [] },
    summary: '',
    education: [],
    experience: [],
    projects: [],
    skills: { technical: ['React'], soft: [], languages: [], tools: [] },
    certifications: [],
    activities: [],
  };

  function build() {
    const cvParser = {
      parse: jest.fn().mockResolvedValue({
        document,
        tokenUsage: 10,
        modelCode: 'gemini-2.0-flash',
        latencyMs: 1,
        promptTemplateVersion: 1,
      }),
    };
    const atsChecker = {
      check: jest.fn().mockReturnValue({
        ats_rule_score: 80,
        summary: { failed: 0, total: 10 },
        rules: [],
      }),
    };
    const prompts = {
      get: jest.fn().mockReturnValue({
        code: 'cv_review_v1',
        version: 1,
        meta: { system: 'sys' },
        body: '',
      }),
      render: jest.fn().mockReturnValue('USER_PROMPT'),
    };
    const llm = {
      complete: jest.fn().mockResolvedValue({
        parsedJson: {},
        rawResponse: '{}',
        tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        latencyMs: 5,
        modelCode: 'gemini-2.0-flash',
      }),
    };
    const parser = {
      parse: jest.fn().mockReturnValue({
        scores: { action_verbs: 15, skills_relevance: 15, experience: 15, education: 15 },
        llm_total: 60,
        rationale: {},
        sections: [],
        ats_extracted: { name: 'Nguyen A', email: null, phone: null, skills_raw: ['React'] },
      }),
    };
    const tracing = {
      startAiRequest: jest.fn().mockResolvedValue('req-1'),
      completeAiRequest: jest.fn().mockResolvedValue(undefined),
      saveAiResult: jest.fn().mockResolvedValue('res-1'),
    };
    const roleRubric = { getRubric: jest.fn().mockReturnValue(null) };

    const service = new CvReviewService(
      llm as never,
      prompts as never,
      tracing as never,
      parser as never,
      atsChecker as never,
      cvParser as never,
      roleRubric as never,
    );
    return { service, cvParser, atsChecker, prompts, llm, parser, tracing, roleRubric };
  }

  const input = {
    cv_id: 'c1',
    parsed_text: 'raw cv text',
    prompt_template_code: 'cv_review_v1',
    target_role: 'Frontend',
  } as never;

  it('composes overall = ats×0.4 + (llm_total/80×100)×0.6', async () => {
    const { service } = build();
    const res = await service.review('u1', input);
    // ats=80, llm_total=60 → llm_normalized=75 → 80×0.4 + 75×0.6 = 32 + 45 = 77
    expect(res.parsed_response.llm_normalized).toBe(75);
    expect(res.total_score).toBe(77);
  });

  it('GAP A+B: feeds the structured document + detected language to the rubric prompt', async () => {
    const { service, prompts } = build();
    await service.review('u1', input);
    const vars = prompts.render.mock.calls[0][1] as Record<string, unknown>;
    // Gap B — language passed
    expect(vars.language).toBe('vi');
    // Gap A — structured document serialized (not just raw text)
    expect(typeof vars.cv).toBe('string');
    expect(vars.cv as string).toContain('"language": "vi"');
    expect(vars.cv as string).toContain('contact');
    // raw text retained as reference
    expect(vars.cv_text).toBe('raw cv text');
  });

  it('surfaces the auto-detected language in the response', async () => {
    const { service } = build();
    const res = await service.review('u1', input);
    expect(res.parsed_response.language).toBe('vi');
  });
});

import { CvReviewService } from '../../../src/modules/cv-review/cv-review.service';

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
    // Deterministic Dim-1: default analyzer returns the SAME score the LLM stub emits (15),
    // so the composite math below stays focused on the weighting, not the routing.
    const bulletAnalyzer = {
      analyze: jest.fn().mockReturnValue({
        bulletCount: 3,
        verbFirstRatio: 1,
        quantifiedRatio: 1,
        weakOpenerRatio: 0,
        firstPersonRatio: 0,
        fillerCount: 0,
        actionVerbsScore: 15,
        band: 'accomplished',
        notes: [],
      }),
    };

    // Dim-2 breakdown engine — default returns nothing; the breakdown test overrides .diff.
    const skillDiff = { diff: jest.fn() };

    const service = new CvReviewService(
      llm as never,
      prompts as never,
      tracing as never,
      parser as never,
      atsChecker as never,
      cvParser as never,
      roleRubric as never,
      bulletAnalyzer as never,
      skillDiff as never,
    );
    return {
      service,
      cvParser,
      atsChecker,
      prompts,
      llm,
      parser,
      tracing,
      roleRubric,
      bulletAnalyzer,
      skillDiff,
    };
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

  it('Routed-Evidence: deterministic Dim-1 OVERRIDES the LLM action_verbs + recomputes llm_total', async () => {
    const { service, bulletAnalyzer } = build();
    // Analyzer disagrees with the LLM stub (which scored action_verbs=15): it says 8.
    bulletAnalyzer.analyze.mockReturnValue({
      bulletCount: 4,
      verbFirstRatio: 0.5,
      quantifiedRatio: 0.25,
      weakOpenerRatio: 0.5,
      firstPersonRatio: 0,
      fillerCount: 0,
      actionVerbsScore: 8,
      band: 'developing',
      notes: ['Many bullets do not start with a strong action verb.'],
    });
    const res = await service.review('u1', input);
    const dims = res.parsed_response.llm_score_dimensions;
    // action_verbs comes from the analyzer, not the LLM (15 → 8).
    expect(dims.action_verbs).toBe(8);
    // llm_total recomputed = 8 + 15 + 15 + 15 = 53.
    expect(res.parsed_response.llm_total).toBe(53);
    expect(res.parsed_response.llm_normalized).toBe(Math.round((53 / 80) * 100));
    // The deterministic signals + the analyzer's rationale are surfaced.
    expect(res.parsed_response.action_verbs_analysis.actionVerbsScore).toBe(8);
    expect(res.parsed_response.rationale.action_verbs).toMatch(/deterministic analysis/);
    expect(res.parsed_response.scoring_weights_version).toBe('scoring-weights-v1');
  });

  it('appends an authoritative Dim-1 section when the LLM section label does not match', async () => {
    const { service, parser } = build();
    parser.parse.mockReturnValue({
      scores: { action_verbs: 15, skills_relevance: 15, experience: 15, education: 15 },
      llm_total: 60,
      rationale: {},
      // VI-localized label that misses isDim1Section /action|verb|impact/i
      sections: [{ name: 'Động từ hành động', score: 90, issues: [] }],
      ats_extracted: { name: null, email: null, phone: null, skills_raw: [] },
    });
    const res = await service.review('u1', input);
    const sections = res.parsed_response.sections;
    // analyzer default score 15 → section score round(15/20*100)=75, prepended + authoritative
    expect(sections[0].name).toBe('Action Verbs & Impact');
    expect(sections[0].score).toBe(75);
    // the LLM's localized section is preserved (not dropped)
    expect(sections.some((s) => s.name === 'Động từ hành động')).toBe(true);
  });

  it('rewrites the matching Dim-1 section in place — replaces stale LLM content, no duplicate', async () => {
    const { service, parser } = build();
    parser.parse.mockReturnValue({
      scores: { action_verbs: 15, skills_relevance: 15, experience: 15, education: 15 },
      llm_total: 60,
      rationale: {},
      sections: [
        { name: 'Action Verbs & Impact', score: 90, issues: [{ severity: 'info', text: 'stale' }] },
      ],
      ats_extracted: { name: null, email: null, phone: null, skills_raw: [] },
    });
    const res = await service.review('u1', input);
    const dim1 = res.parsed_response.sections.filter((s) => /action/i.test(s.name));
    expect(dim1).toHaveLength(1); // not duplicated
    expect(dim1[0].score).toBe(75); // stale 90 replaced by the deterministic value
  });

  // ─── fast-follow: Dim-2 breakdown + top_summary (deterministic, no LLM) ───────

  it('builds a deterministic Dim-2 matched/missing breakdown when a role rubric exists', async () => {
    const { service, roleRubric, skillDiff, parser } = build();
    roleRubric.getRubric.mockReturnValue({ role_code: 'frontend', skills: [] });
    parser.parse.mockReturnValue({
      scores: { action_verbs: 15, skills_relevance: 12, experience: 15, education: 15 },
      llm_total: 57,
      rationale: {},
      sections: [],
      ats_extracted: {
        name: null,
        email: null,
        phone: null,
        skills_raw: ['React'],
        skills_extracted: [{ name: 'React', proficiency_hint: 'advanced', evidence_text: null }],
      },
    });
    skillDiff.diff.mockReturnValue({
      matched_skills: [
        { display_name: 'React', importance: 'REQUIRED', required_level: 3, cv_level: 4 },
      ],
      partial_skills: [],
      missing_skills: [{ display_name: 'TypeScript', importance: 'REQUIRED', required_level: 4 }],
    });
    const res = await service.review('u1', input);
    const bd = res.parsed_response.skills_relevance_breakdown;
    expect(bd).not.toBeNull();
    expect(bd?.matched.map((m) => m.name)).toEqual(['React']);
    expect(bd?.missing.map((m) => m.name)).toEqual(['TypeScript']);
    // top_summary surfaces the missing required skill as a prioritized fix.
    expect(res.parsed_response.top_summary.prioritized_actions.join(' ')).toContain('TypeScript');
  });

  it('skills_relevance_breakdown is null when there is no rubric for the role', async () => {
    const { service } = build(); // roleRubric.getRubric → null by default
    const res = await service.review('u1', input);
    expect(res.parsed_response.skills_relevance_breakdown).toBeNull();
  });

  it('top_summary prioritizes quantification (in the CV language) when few bullets have numbers', async () => {
    const { service, bulletAnalyzer } = build();
    bulletAnalyzer.analyze.mockReturnValue({
      bulletCount: 4,
      verbFirstRatio: 1,
      quantifiedRatio: 0.25,
      weakOpenerRatio: 0,
      firstPersonRatio: 0,
      fillerCount: 0,
      actionVerbsScore: 17,
      band: 'accomplished',
      notes: [],
    });
    const res = await service.review('u1', input);
    const ts = res.parsed_response.top_summary;
    expect(ts.prioritized_actions.length).toBeGreaterThan(0);
    expect(ts.prioritized_actions[0]).toMatch(/số liệu/); // vi CV → vi action
    expect(ts.headline).toContain('/100');
  });
});

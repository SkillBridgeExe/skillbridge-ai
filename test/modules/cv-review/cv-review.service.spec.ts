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
      analyzeBullets: jest.fn().mockReturnValue([]),
      detectBuzzwords: jest.fn().mockReturnValue([]),
    };

    // Dim-2 breakdown engine — default returns nothing; the breakdown test overrides .diff.
    const skillDiff = { diff: jest.fn() };

    // Evidence Ledger deps — lightweight mocks (no taxonomy init needed in this unit spec).
    const scanner = { scan: jest.fn().mockReturnValue([]) };
    const normalizer = { getByCanonical: jest.fn().mockReturnValue(undefined) };

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
      scanner as never,
      normalizer as never,
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
      scanner,
      normalizer,
    };
  }

  // Realistic-length CV text: the Step-0 content gate (CV_CONTENT_INSUFFICIENT) requires
  // >=15 meaningful tokens or >=80 meaningful chars — a real CV always clears it.
  const input = {
    cv_id: 'c1',
    parsed_text:
      'Nguyễn Văn A — Frontend Developer. Kinh nghiệm: thực tập sinh tại FPT Software, ' +
      'xây dựng giao diện quản trị nội bộ với ReactJS và TypeScript, tối ưu hiệu năng render. ' +
      'Dự án: Web bán hàng EcomViet (React, Redux). Kỹ năng: HTML, CSS, JavaScript, Git.',
    prompt_template_code: 'cv_review_v1',
    target_role: 'Frontend',
  } as never;

  it('Step-0 gate: junk/blank-scan parsed_text is rejected BEFORE any LLM stage', async () => {
    const { service, llm, cvParser } = build();
    await expect(
      service.review('u1', { ...(input as object), parsed_text: 'aa aa aa' } as never),
    ).rejects.toMatchObject({ response: { code: 'CV_CONTENT_INSUFFICIENT' } });
    expect(cvParser.parse).not.toHaveBeenCalled(); // Stage-1 LLM never reached
    expect(llm.complete).not.toHaveBeenCalled(); // Stage-3 LLM never reached
  });

  it('composes overall = ats×0.4 + (llm_total/80×100)×0.6', async () => {
    const { service } = build();
    const res = await service.review('u1', input);
    // ats=80, llm_total base 60 → but the fixture document has NO experience/projects, so E3's
    // deterministic Dim-3 override kicks in (0 entries -> score20=2, not the LLM's 15), AND the
    // fixture document has NO education entries + the fixture's parsed_text has no education
    // token, so E4's deterministic Dim-4 override also kicks in (0 entries, no token -> score20=4,
    // not the LLM's 15): llm_total = 15(action_verbs) + 15(skills_relevance) + 2(experience) +
    // 4(education) = 36. llm_normalized = round(36/80*100) = 45 → 80×0.4 + 45×0.6 = 32 + 27 = 59.
    expect(res.parsed_response.llm_normalized).toBe(45);
    expect(res.total_score).toBe(59);
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
    // raw text retained as reference (the realistic fixture text)
    expect(vars.cv_text).toContain('Frontend Developer');
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
    // llm_total recomputed = 8 + 15 + 2 + 4 = 29. The `experience` term is 2 (E3: fixture document
    // has NO experience/projects) and the `education` term is 4 (E4: fixture document has NO
    // education entries + the fixture's parsed_text has no education token) — not the LLM's 15/15.
    expect(res.parsed_response.llm_total).toBe(29);
    expect(res.parsed_response.llm_normalized).toBe(Math.round((29 / 80) * 100));
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
    // analyzer default score 15 → section score round(15/20*100)=75, prepended + authoritative.
    // (Not necessarily sections[0]: the fixture document has no experience/projects, so E3's
    // Dim-3 route ALSO prepends its own "Experience" section — find by name instead of index.)
    const dim1 = sections.find((s) => s.name === 'Action Verbs & Impact');
    expect(dim1?.score).toBe(75);
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

  it('appends an authoritative Dim-2 section when the LLM section label does not match', async () => {
    const { service, parser, roleRubric, skillDiff } = build();
    roleRubric.getRubric.mockReturnValue({ role_code: 'frontend', skills: [] });
    parser.parse.mockReturnValue({
      scores: { action_verbs: 15, skills_relevance: 15, experience: 15, education: 15 },
      llm_total: 60,
      rationale: {},
      // LLM label does not match /skill/i (e.g., "Kỹ năng kỹ thuật" → will NOT match isDim2Section)
      sections: [{ name: 'Proficiency Summary', score: 85, issues: [] }],
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
        {
          display_name: 'React',
          importance: 'REQUIRED',
          required_level: 3,
          cv_level: 4,
        },
      ],
      partial_skills: [],
      missing_skills: [{ display_name: 'TypeScript', importance: 'REQUIRED', required_level: 4 }],
      overall_score: 50,
    });
    const res = await service.review('u1', input);
    const sections = res.parsed_response.sections;
    // Deterministic Dim-2 section with score=round(50/100*20/20*100)=50, prepended + authoritative
    const dim2 = sections.filter((s) => /skill/i.test(s.name));
    expect(dim2.length).toBeGreaterThan(0);
    expect(dim2[0].name).toBe('Skills Relevance');
    expect(dim2[0].score).toBe(50);
    // The LLM's non-matching section is preserved (not dropped)
    expect(sections.some((s) => s.name === 'Proficiency Summary')).toBe(true);
  });

  it('rewrites the matching Dim-2 section in place — replaces stale LLM content, no duplicate', async () => {
    const { service, parser, roleRubric, skillDiff } = build();
    roleRubric.getRubric.mockReturnValue({ role_code: 'frontend', skills: [] });
    parser.parse.mockReturnValue({
      scores: { action_verbs: 15, skills_relevance: 15, experience: 15, education: 15 },
      llm_total: 60,
      rationale: {},
      sections: [
        {
          name: 'Skills Matching',
          score: 90,
          issues: [{ severity: 'warning', text: 'stale LLM analysis' }],
        },
      ],
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
        {
          display_name: 'React',
          importance: 'REQUIRED',
          required_level: 3,
          cv_level: 4,
        },
      ],
      partial_skills: [],
      missing_skills: [{ display_name: 'TypeScript', importance: 'REQUIRED', required_level: 4 }],
      overall_score: 60,
    });
    const res = await service.review('u1', input);
    const dim2 = res.parsed_response.sections.filter((s) => /skill/i.test(s.name));
    expect(dim2).toHaveLength(1); // not duplicated
    expect(dim2[0].score).toBe(60); // stale 90 replaced by the deterministic value
    // Authoritative issues from breakdown (not LLM's stale analysis)
    expect(dim2[0].issues.some((i) => i.text.includes('TypeScript'))).toBe(true);
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
      overall_score: 50, // 1/2 role skills matched — consumed by routeDimension2 (SE-1a)
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

  it('enriches the review with bullet_feedback, buzzwords_detected, and skill_type', async () => {
    const { service } = build();
    const res = await service.review('u1', input);
    const p = res.parsed_response;
    expect(Array.isArray(p.bullet_feedback)).toBe(true);
    expect(Array.isArray(p.buzzwords_detected)).toBe(true);
    if (p.skills_relevance_breakdown) {
      const items = [
        ...p.skills_relevance_breakdown.matched,
        ...p.skills_relevance_breakdown.missing,
      ];
      if (items.length) expect(['hard', 'soft']).toContain(items[0].skill_type);
    }
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

  // ─── SE-1a: deterministic skills_relevance score from the rubric diff ────────

  it('SE-1a: deterministic rubric diff OWNS Dim-2 score + recomputes llm_total/overall_score + provenance', async () => {
    const { service, roleRubric, skillDiff, parser } = build();
    roleRubric.getRubric.mockReturnValue({ role_code: 'frontend', skills: [] });
    parser.parse.mockReturnValue({
      // LLM says skills_relevance=5 — deliberately far from the deterministic diff below, so a
      // pass proves the OVERRIDE happened (not a coincidence).
      scores: { action_verbs: 15, skills_relevance: 5, experience: 15, education: 15 },
      llm_total: 50,
      rationale: { skills_relevance: 'LLM guess' },
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
      missing_skills: [
        { display_name: 'TypeScript', importance: 'REQUIRED', required_level: 4 },
        { display_name: 'Redux', importance: 'PREFERRED', required_level: 2 },
      ],
      overall_score: 60, // → score20 = round(60/100*20) = 12
    });
    const res = await service.review('u1', input);
    const dims = res.parsed_response.llm_score_dimensions;
    expect(dims.skills_relevance).toBe(12); // NOT the LLM's 5
    // llm_total recomputed = 15 (action_verbs, unchanged from analyzer default) + 12 + 2 (experience,
    // E3 override: fixture document has no experience/projects) + 4 (education, E4 override: fixture
    // document has no education entries + fixture parsed_text has no education token) = 33
    expect(res.parsed_response.llm_total).toBe(33);
    expect(res.parsed_response.llm_normalized).toBe(Math.round((33 / 80) * 100));
    // Templated bilingual rationale — CV language is 'vi' — with real matched/missing counts.
    expect(res.parsed_response.rationale.skills_relevance).toMatch(/Khớp 1\/3/);
    expect(res.parsed_response.rationale.skills_relevance).toMatch(/TypeScript/);
    expect(res.parsed_response.rationale.skills_relevance).toMatch(/Redux/);
    expect(res.parsed_response.dimension_provenance?.skills_relevance).toEqual({
      source: 'deterministic',
      confidence: 'high',
      evidence: expect.arrayContaining([
        expect.stringContaining('matched'),
        expect.stringContaining('missing'),
      ]),
    });
  });

  it('SE-1a edge: diff.overall_score=0 → score20=0, rationale adapts when nothing is missing', async () => {
    const { service, roleRubric, skillDiff, parser } = build();
    roleRubric.getRubric.mockReturnValue({ role_code: 'frontend', skills: [] });
    parser.parse.mockReturnValue({
      scores: { action_verbs: 15, skills_relevance: 20, experience: 15, education: 15 },
      llm_total: 65,
      rationale: {},
      sections: [],
      ats_extracted: { name: null, email: null, phone: null, skills_raw: [], skills_extracted: [] },
    });
    skillDiff.diff.mockReturnValue({
      matched_skills: [],
      partial_skills: [],
      missing_skills: [],
      overall_score: 0,
    });
    const res = await service.review('u1', input);
    expect(res.parsed_response.llm_score_dimensions.skills_relevance).toBe(0);
    // No missing skills — the "thiếu:" clause must not appear (graceful, not an empty "thiếu:").
    expect(res.parsed_response.rationale.skills_relevance).not.toMatch(/thiếu:\s*\./);
    expect(res.parsed_response.rationale.skills_relevance).toMatch(/Khớp 0\/0/);
  });

  it('SE-1a: no rubric → keeps the LLM skills_relevance score + provenance source llm', async () => {
    const { service, parser } = build(); // roleRubric.getRubric → null by default (no target_role rubric)
    const knownRationale = 'CV shows foundational technical skills for the role.';
    parser.parse.mockReturnValue({
      scores: { action_verbs: 15, skills_relevance: 15, experience: 15, education: 15 },
      llm_total: 60,
      rationale: { skills_relevance: knownRationale },
      sections: [],
      ats_extracted: { name: null, email: null, phone: null, skills_raw: [] },
    });
    const res = await service.review('u1', input);
    // Default parser stub scores skills_relevance=15 — untouched (no rubric to override it).
    expect(res.parsed_response.llm_score_dimensions.skills_relevance).toBe(15);
    expect(res.parsed_response.dimension_provenance?.skills_relevance?.source).toBe('llm');
    expect(res.parsed_response.dimension_provenance?.skills_relevance?.evidence).toEqual([
      knownRationale,
    ]);
  });

  it('SE-1a: provenance.action_verbs is deterministic with ratio evidence when Dim-1 is routed', async () => {
    const { service } = build();
    const res = await service.review('u1', input);
    expect(res.parsed_response.dimension_provenance?.action_verbs).toEqual({
      source: 'deterministic',
      confidence: 'high',
      evidence: expect.arrayContaining([expect.any(String), expect.any(String)]),
    });
  });

  it('attaches evidence_ledger to the parsed response (display-only, structure always present)', async () => {
    const { service } = build();
    const res = await service.review('u1', input);
    // Evidence ledger is attached (display-only). Structure always present.
    const ledger = res.parsed_response.evidence_ledger;
    expect(ledger).toBeDefined();
    expect(Array.isArray(ledger!.items)).toBe(true);
    expect(Array.isArray(ledger!.evidence_gap)).toBe(true);
  });

  // ─── E3: deterministic experience scoring (Dim-3) ────────────────────────────

  const experienceBullets = [
    {
      text: 'Built X',
      section: 'experience' as const,
      verbFirst: true,
      quantified: true,
      weakOpener: false,
      firstPerson: false,
      fillerCount: 0,
      tips: [],
    },
    {
      text: 'Led Y',
      section: 'experience' as const,
      verbFirst: true,
      quantified: true,
      weakOpener: false,
      firstPerson: false,
      fillerCount: 0,
      tips: [],
    },
  ];

  it('E3: deterministic experience score OWNS Dim-3 + recomputes llm_total/overall_score + provenance evidence', async () => {
    const { service, cvParser, bulletAnalyzer, parser } = build();
    cvParser.parse.mockResolvedValue({
      document: {
        ...document,
        experience: [
          {
            org: 'A',
            role: 'Dev',
            start: '2020',
            end: '2022',
            location: null,
            bullets: ['a', 'b'],
          },
        ],
      },
      tokenUsage: 10,
      modelCode: 'gemini-2.0-flash',
      latencyMs: 1,
      promptTemplateVersion: 1,
    });
    bulletAnalyzer.analyzeBullets.mockReturnValue(experienceBullets);
    parser.parse.mockReturnValue({
      // LLM guesses experience=5 — deliberately far off, so a pass proves the OVERRIDE happened.
      scores: { action_verbs: 15, skills_relevance: 15, experience: 5, education: 15 },
      llm_total: 50,
      rationale: { experience: 'LLM guess' },
      sections: [],
      ats_extracted: { name: null, email: null, phone: null, skills_raw: [] },
    });
    const res = await service.review('u1', input);
    const dims = res.parsed_response.llm_score_dimensions;
    // quantity: 1 entry * 3 = 3, +2 seniority bonus (est_years=2, confidence high) = 5
    // quality: quantifiedRatio=1 -> 5, verbFirstRatio=1 -> 3 = 8. total = 13
    expect(dims.experience).toBe(13); // NOT the LLM's 5
    // llm_total recomputed = 15 (action_verbs, analyzer default) + 15 (skills_relevance, no rubric ->
    // LLM) + 13 + 4 (education, E4 override: this document still has no education entries + the
    // fixture parsed_text has no education token) = 47
    expect(res.parsed_response.llm_total).toBe(47);
    expect(res.parsed_response.llm_normalized).toBe(Math.round((47 / 80) * 100));
    // rationale.experience replaced with the scorer's vi rationale (document.language is 'vi').
    expect(res.parsed_response.rationale.experience).not.toBe('LLM guess');
    expect(res.parsed_response.rationale.experience).toMatch(/kinh nghiệm/);
    expect(res.parsed_response.dimension_provenance?.experience).toEqual({
      source: 'deterministic',
      confidence: 'medium', // 1 experience entry -> medium regardless of bullet count
      evidence: expect.arrayContaining([
        expect.stringContaining('experience entries'),
        expect.stringContaining('quantified'),
      ]),
    });
  });

  it('E3: appends an authoritative Experience section when the LLM section label does not match', async () => {
    const { service, cvParser, bulletAnalyzer, parser } = build();
    cvParser.parse.mockResolvedValue({
      document: {
        ...document,
        experience: [
          {
            org: 'A',
            role: 'Dev',
            start: '2020',
            end: '2022',
            location: null,
            bullets: ['a', 'b'],
          },
        ],
      },
      tokenUsage: 10,
      modelCode: 'gemini-2.0-flash',
      latencyMs: 1,
      promptTemplateVersion: 1,
    });
    bulletAnalyzer.analyzeBullets.mockReturnValue(experienceBullets);
    parser.parse.mockReturnValue({
      scores: { action_verbs: 15, skills_relevance: 15, experience: 5, education: 15 },
      llm_total: 50,
      rationale: {},
      // Label does not match /experience|kinh nghiệm/i
      sections: [{ name: 'Work History Summary', score: 20, issues: [] }],
      ats_extracted: { name: null, email: null, phone: null, skills_raw: [] },
    });
    const res = await service.review('u1', input);
    const sections = res.parsed_response.sections;
    const dim3 = sections.filter((s) => s.name === 'Experience');
    expect(dim3).toHaveLength(1);
    expect(dim3[0].score).toBe(Math.round((13 / 20) * 100));
    // The LLM's non-matching section is preserved (not dropped)
    expect(sections.some((s) => s.name === 'Work History Summary')).toBe(true);
  });

  it('E3: rewrites the matching Experience section in place — replaces stale LLM content, no duplicate', async () => {
    const { service, cvParser, bulletAnalyzer, parser } = build();
    cvParser.parse.mockResolvedValue({
      document: {
        ...document,
        experience: [
          {
            org: 'A',
            role: 'Dev',
            start: '2020',
            end: '2022',
            location: null,
            bullets: ['a', 'b'],
          },
        ],
      },
      tokenUsage: 10,
      modelCode: 'gemini-2.0-flash',
      latencyMs: 1,
      promptTemplateVersion: 1,
    });
    bulletAnalyzer.analyzeBullets.mockReturnValue(experienceBullets);
    parser.parse.mockReturnValue({
      scores: { action_verbs: 15, skills_relevance: 15, experience: 5, education: 15 },
      llm_total: 50,
      rationale: {},
      sections: [{ name: 'Experience', score: 90, issues: [{ severity: 'info', text: 'stale' }] }],
      ats_extracted: { name: null, email: null, phone: null, skills_raw: [] },
    });
    const res = await service.review('u1', input);
    const dim3 = res.parsed_response.sections.filter((s) => s.name === 'Experience');
    expect(dim3).toHaveLength(1); // not duplicated
    expect(dim3[0].score).toBe(Math.round((13 / 20) * 100)); // stale 90 replaced
  });

  it('E3: signal too thin (entries>0 but <2 bullets) → null → keeps the LLM experience score + provenance llm', async () => {
    const { service, cvParser, bulletAnalyzer, parser } = build();
    cvParser.parse.mockResolvedValue({
      document: {
        ...document,
        experience: [
          { org: 'A', role: 'Dev', start: '2020', end: '2022', location: null, bullets: ['a'] },
        ],
      },
      tokenUsage: 10,
      modelCode: 'gemini-2.0-flash',
      latencyMs: 1,
      promptTemplateVersion: 1,
    });
    // Only 1 relevant bullet — below MIN_BULLETS_FOR_SIGNAL(2) -> scorer returns null.
    bulletAnalyzer.analyzeBullets.mockReturnValue([experienceBullets[0]]);
    const knownRationale = 'CV shows solid on-the-job experience.';
    parser.parse.mockReturnValue({
      scores: { action_verbs: 15, skills_relevance: 15, experience: 15, education: 15 },
      llm_total: 60,
      rationale: { experience: knownRationale },
      sections: [],
      ats_extracted: { name: null, email: null, phone: null, skills_raw: [] },
    });
    const res = await service.review('u1', input);
    // Untouched — no scorer override.
    expect(res.parsed_response.llm_score_dimensions.experience).toBe(15);
    expect(res.parsed_response.rationale.experience).toBe(knownRationale);
    expect(res.parsed_response.dimension_provenance?.experience).toEqual({
      source: 'llm',
      confidence: 'medium',
      evidence: [knownRationale],
    });
  });

  // ─── E4: deterministic education scoring (Dim-4) ─────────────────────────────

  const educationEntry = {
    school: 'ABC University',
    degree: 'Bachelor of Science',
    field: 'CS',
    start: '2018',
    end: '2022',
    gpa: '3.6/4.0',
    highlights: [],
  };

  it('E4: deterministic education score OWNS Dim-4 + recomputes llm_total/overall_score + provenance evidence', async () => {
    const { service, cvParser, parser } = build();
    cvParser.parse.mockResolvedValue({
      document: { ...document, education: [educationEntry] },
      tokenUsage: 10,
      modelCode: 'gemini-2.0-flash',
      latencyMs: 1,
      promptTemplateVersion: 1,
    });
    parser.parse.mockReturnValue({
      // LLM guesses education=5 — deliberately far off, so a pass proves the OVERRIDE happened.
      scores: { action_verbs: 15, skills_relevance: 15, experience: 15, education: 5 },
      llm_total: 50,
      rationale: { education: 'LLM guess' },
      sections: [],
      ats_extracted: { name: null, email: null, phone: null, skills_raw: [] },
    });
    const res = await service.review('u1', input);
    const dims = res.parsed_response.llm_score_dimensions;
    // school(8) + bachelor(6) + CS field(4) + GPA 3.6/4.0 above threshold(2) = 20.
    expect(dims.education).toBe(20); // NOT the LLM's 5
    // llm_total recomputed = 15 (action_verbs, analyzer default) + 15 (skills_relevance, no rubric ->
    // LLM) + 2 (experience, E3 override: this document still has no experience/projects) + 20 = 52
    expect(res.parsed_response.llm_total).toBe(52);
    expect(res.parsed_response.llm_normalized).toBe(Math.round((52 / 80) * 100));
    // rationale.education replaced with the scorer's vi rationale (document.language is 'vi').
    expect(res.parsed_response.rationale.education).not.toBe('LLM guess');
    expect(res.parsed_response.rationale.education).toMatch(/học vấn/);
    expect(res.parsed_response.dimension_provenance?.education).toEqual({
      source: 'deterministic',
      confidence: 'high',
      evidence: expect.arrayContaining([
        expect.stringContaining('education entries'),
        expect.stringContaining('degree=bachelor'),
      ]),
    });
  });

  it('E4: appends an authoritative Education section when the LLM section label does not match', async () => {
    const { service, cvParser, parser } = build();
    cvParser.parse.mockResolvedValue({
      document: { ...document, education: [educationEntry] },
      tokenUsage: 10,
      modelCode: 'gemini-2.0-flash',
      latencyMs: 1,
      promptTemplateVersion: 1,
    });
    parser.parse.mockReturnValue({
      scores: { action_verbs: 15, skills_relevance: 15, experience: 15, education: 5 },
      llm_total: 50,
      rationale: {},
      // Label does not match /education|học vấn|hoc van/i
      sections: [{ name: 'Academic Background', score: 20, issues: [] }],
      ats_extracted: { name: null, email: null, phone: null, skills_raw: [] },
    });
    const res = await service.review('u1', input);
    const sections = res.parsed_response.sections;
    const dim4 = sections.filter((s) => s.name === 'Education');
    expect(dim4).toHaveLength(1);
    expect(dim4[0].score).toBe(Math.round((20 / 20) * 100));
    // The LLM's non-matching section is preserved (not dropped)
    expect(sections.some((s) => s.name === 'Academic Background')).toBe(true);
  });

  it('E4: rewrites the matching Education section in place — replaces stale LLM content, no duplicate', async () => {
    const { service, cvParser, parser } = build();
    cvParser.parse.mockResolvedValue({
      document: { ...document, education: [educationEntry] },
      tokenUsage: 10,
      modelCode: 'gemini-2.0-flash',
      latencyMs: 1,
      promptTemplateVersion: 1,
    });
    parser.parse.mockReturnValue({
      scores: { action_verbs: 15, skills_relevance: 15, experience: 15, education: 5 },
      llm_total: 50,
      rationale: {},
      sections: [{ name: 'Education', score: 90, issues: [{ severity: 'info', text: 'stale' }] }],
      ats_extracted: { name: null, email: null, phone: null, skills_raw: [] },
    });
    const res = await service.review('u1', input);
    const dim4 = res.parsed_response.sections.filter((s) => s.name === 'Education');
    expect(dim4).toHaveLength(1); // not duplicated
    expect(dim4[0].score).toBe(Math.round((20 / 20) * 100)); // stale 90 replaced
  });

  it('E4: empty education[] + rawText mentions a degree keyword (parser-miss guard) → null → keeps the LLM education score + provenance llm', async () => {
    const { service, parser } = build();
    // Fixture document already has education: [] — override parsed_text to include a degree
    // keyword so scoreEducation's parser-miss guard fires (fallback to the LLM, not a 4-point floor).
    const inputWithEduToken = {
      ...(input as object),
      parsed_text: `${(input as { parsed_text: string }).parsed_text} Tốt nghiệp Đại học Bách Khoa.`,
    } as never;
    const knownRationale = 'CV shows a relevant bachelor degree.';
    parser.parse.mockReturnValue({
      scores: { action_verbs: 15, skills_relevance: 15, experience: 15, education: 15 },
      llm_total: 60,
      rationale: { education: knownRationale },
      sections: [],
      ats_extracted: { name: null, email: null, phone: null, skills_raw: [] },
    });
    const res = await service.review('u1', inputWithEduToken);
    // Untouched — no scorer override.
    expect(res.parsed_response.llm_score_dimensions.education).toBe(15);
    expect(res.parsed_response.rationale.education).toBe(knownRationale);
    expect(res.parsed_response.dimension_provenance?.education).toEqual({
      source: 'llm',
      confidence: 'medium',
      evidence: [knownRationale],
    });
  });
});

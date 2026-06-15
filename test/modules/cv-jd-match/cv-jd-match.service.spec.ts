import { CvJdMatchService } from '../../../src/modules/cv-jd-match/cv-jd-match.service';

/**
 * Gate-focused unit tests with mocked deps — the full extraction/diff path is covered by
 * eval:match + skill-diff specs; here we pin the JD content gate added after the owner's QA:
 * a PROVIDED-but-garbage JD must be rejected BEFORE the extraction LLM runs.
 */
describe('CvJdMatchService — JD content gate', () => {
  const build = () => {
    const llm = { complete: jest.fn() };
    const prompts = {
      get: jest.fn().mockReturnValue({ code: 'cv_jd_match', version: 1, meta: { system: 's' } }),
      render: jest.fn().mockReturnValue('rendered'),
    };
    const tracing = {
      startAiRequest: jest.fn().mockResolvedValue('req-1'),
      saveAiResult: jest.fn().mockResolvedValue('res-1'),
      completeAiRequest: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };
    const skillDiff = { diff: jest.fn() };
    const scanner = { scan: jest.fn().mockReturnValue([]) };
    const svc = new CvJdMatchService(
      llm as never,
      prompts as never,
      tracing as never,
      skillDiff as never,
      scanner as never,
    );
    return { svc, llm, tracing };
  };

  const baseInput = {
    cv_id: 'cv-1',
    cv_text: 'Frontend developer with ReactJS and TypeScript experience at FPT Software.',
    scoring_template_code: 'cv_jd_match_v1',
    target_role: 'frontend_developer',
  };

  it('rejects a provided-but-garbage JD with JD_CONTENT_INSUFFICIENT before any LLM/tracing work', async () => {
    const { svc, llm, tracing } = build();
    await expect(
      svc.match('user-1', { ...baseInput, jd_text: 'aa test test' } as never),
    ).rejects.toMatchObject({ response: { code: 'JD_CONTENT_INSUFFICIENT' } });
    expect(llm.complete).not.toHaveBeenCalled();
    expect(tracing.startAiRequest).not.toHaveBeenCalled();
  });

  it('rejects a too-thin JD ("React dev")', async () => {
    const { svc, llm } = build();
    await expect(
      svc.match('user-1', { ...baseInput, jd_text: 'React dev' } as never),
    ).rejects.toMatchObject({ response: { code: 'JD_CONTENT_INSUFFICIENT' } });
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('an ABSENT/empty JD stays legal (rubric fallback path) — gate does not fire', async () => {
    const llm = {
      complete: jest.fn().mockResolvedValue({
        parsedJson: { cv_skills_raw: [], jd_requirements_raw: [] },
        rawResponse: '{}',
        tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        estimatedCostUsd: 0,
        latencyMs: 1,
      }),
    };
    const prompts = {
      get: jest.fn().mockReturnValue({ code: 'cv_jd_match', version: 1, meta: { system: 's' } }),
      render: jest.fn().mockReturnValue('rendered'),
    };
    const tracing = {
      startAiRequest: jest.fn().mockResolvedValue('req-1'),
      saveAiResult: jest.fn().mockResolvedValue('res-1'),
      completeAiRequest: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };
    const skillDiff = {
      diff: jest.fn().mockReturnValue({
        matched_skills: [],
        partial_skills: [],
        missing_skills: [],
        bonus_skills: [],
        unnormalized_cv_skills: [],
        unnormalized_jd_requirements: [],
        match_ratio: 0,
        required_coverage: 1,
        overall_score: 0,
        requirements_source: 'none',
        scoring_breakdown: {
          total_requirements: 0,
          matched_count: 0,
          partial_count: 0,
          missing_count: 0,
          weight_sum: 0,
          achieved_weight: 0,
          required_total: 0,
          required_met: 0,
          raw_weighted_score: 0,
          cap_applied: false,
        },
        inferred_skills: [],
      }),
    };
    const scanner = { scan: jest.fn().mockReturnValue([]) };
    const svc = new CvJdMatchService(
      llm as never,
      prompts as never,
      tracing as never,
      skillDiff as never,
      scanner as never,
    );
    const res = await svc.match('user-1', { ...baseInput } as never);
    expect(llm.complete).toHaveBeenCalled(); // gate let the no-JD request through
    expect(res.parsed_response.overall_score).toBe(0);
  });
});

/**
 * OFF-TOPIC JD gate (post-extraction): a PROVIDED JD that passes the thin-content gate but
 * yields ZERO extracted job requirements (while the CV side extracts fine) must be rejected
 * deterministically — silently falling back to the role rubric would score the CV against
 * requirements the user never pasted (live repro: a phở recipe scored "26% match"). The LLM
 * call already happened → its trace completes as SUCCESS (cost stays visible), never FAILED.
 */
describe('CvJdMatchService — OFF-TOPIC JD gate (post-extraction)', () => {
  const diffResult = {
    matched_skills: [],
    partial_skills: [],
    missing_skills: [],
    bonus_skills: [],
    unnormalized_cv_skills: [],
    unnormalized_jd_requirements: [],
    match_ratio: 0,
    required_coverage: 1,
    overall_score: 0,
    requirements_source: 'role_rubric',
    scoring_breakdown: {
      total_requirements: 0,
      matched_count: 0,
      partial_count: 0,
      missing_count: 0,
      weight_sum: 0,
      achieved_weight: 0,
      required_total: 0,
      required_met: 0,
      raw_weighted_score: 0,
      cap_applied: false,
    },
    inferred_skills: [],
  };

  const build = (parsedJson: unknown) => {
    const llm = {
      complete: jest.fn().mockResolvedValue({
        parsedJson,
        rawResponse: '{}',
        tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        estimatedCostUsd: 0.001,
        latencyMs: 42,
      }),
    };
    const prompts = {
      get: jest.fn().mockReturnValue({ code: 'cv_jd_match', version: 1, meta: { system: 's' } }),
      render: jest.fn().mockReturnValue('rendered'),
    };
    const tracing = {
      startAiRequest: jest.fn().mockResolvedValue('req-1'),
      saveAiResult: jest.fn().mockResolvedValue('res-1'),
      completeAiRequest: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };
    const skillDiff = { diff: jest.fn().mockReturnValue(diffResult) };
    const scanner = { scan: jest.fn().mockReturnValue([]) };
    const svc = new CvJdMatchService(
      llm as never,
      prompts as never,
      tracing as never,
      skillDiff as never,
      scanner as never,
    );
    return { svc, llm, tracing, skillDiff };
  };

  const baseInput = {
    cv_id: 'cv-1',
    cv_text: 'Backend developer with .NET, SQL Server and Docker experience at FPT Software.',
    scoring_template_code: 'cv_jd_match_v1',
    target_role: 'backend_developer',
  };

  // The live repro: real meaningful Vietnamese text (passes the thin gate) with zero job content.
  const phoJd =
    'Công thức nấu phở bò gia truyền: xương bò ninh tám tiếng với quế hồi thảo quả, ' +
    'nước dùng trong vắt, bánh phở tươi, thịt bò tái nạm gầu, hành ngò rau thơm ăn kèm tương ớt.';

  it('rejects a provided-but-off-topic JD (zero extracted requirements) AFTER the LLM call', async () => {
    const { svc, llm, tracing, skillDiff } = build({
      cv_skills_raw: [{ raw_input: '.NET', evidence_text: 'CV says .NET', level_hint: 3 }],
      jd_requirements_raw: [],
    });
    await expect(
      svc.match('user-1', { ...baseInput, jd_text: phoJd } as never),
    ).rejects.toMatchObject({ response: { code: 'JD_CONTENT_INSUFFICIENT' } });
    expect(llm.complete).toHaveBeenCalled(); // post-extraction gate: the call DID happen
    expect(skillDiff.diff).not.toHaveBeenCalled(); // never scored against the rubric
    // Cost stays visible: trace completed SUCCESS, never flipped to FAILED.
    expect(tracing.completeAiRequest).toHaveBeenCalledWith(
      'req-1',
      expect.objectContaining({ status: 'SUCCESS', totalTokens: 15 }),
    );
    expect(tracing.markFailed).not.toHaveBeenCalled();
  });

  it('BOTH sides empty (extraction hiccup) is ambiguous — NOT rejected as off-topic', async () => {
    const { svc, skillDiff, tracing } = build({ cv_skills_raw: [], jd_requirements_raw: [] });
    await svc.match('user-1', { ...baseInput, jd_text: phoJd } as never);
    expect(skillDiff.diff).toHaveBeenCalled(); // proceeds (rubric path) instead of blaming the JD
    expect(tracing.markFailed).not.toHaveBeenCalled();
  });

  it('a JD with extracted requirements proceeds normally', async () => {
    const { svc, skillDiff } = build({
      cv_skills_raw: [{ raw_input: '.NET', evidence_text: 'CV says .NET', level_hint: 3 }],
      jd_requirements_raw: [
        { raw_input: 'C#', evidence_text: 'JD requires C#', importance: 'REQUIRED' },
      ],
    });
    const res = await svc.match('user-1', { ...baseInput, jd_text: phoJd } as never);
    expect(skillDiff.diff).toHaveBeenCalled();
    expect(res.parsed_response.overall_score).toBe(0);
  });
});

describe('CvJdMatchService — band default (product layer)', () => {
  it('passes target_band fresher to the diff when the request omits it (rubric path default)', async () => {
    const llm = {
      complete: jest.fn().mockResolvedValue({
        parsedJson: {
          cv_skills_raw: [{ name: 'React', proficiency_hint: 'ADVANCED' }],
          jd_requirements_raw: [],
        },
        rawResponse: '{}',
        tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        estimatedCostUsd: 0,
        latencyMs: 1,
      }),
    };
    const prompts = {
      get: jest.fn().mockReturnValue({ code: 'cv_jd_match', version: 1, meta: { system: 's' } }),
      render: jest.fn().mockReturnValue('rendered'),
    };
    const tracing = {
      startAiRequest: jest.fn().mockResolvedValue('req-1'),
      saveAiResult: jest.fn().mockResolvedValue('res-1'),
      completeAiRequest: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };
    const skillDiff = {
      diff: jest.fn().mockReturnValue({
        matched_skills: [],
        partial_skills: [],
        missing_skills: [],
        bonus_skills: [],
        unnormalized_cv_skills: [],
        unnormalized_jd_requirements: [],
        match_ratio: 0,
        required_coverage: 1,
        overall_score: 0,
        requirements_source: 'role_rubric',
        rubric_band: 'fresher',
        scoring_breakdown: {
          total_requirements: 0,
          matched_count: 0,
          partial_count: 0,
          missing_count: 0,
          weight_sum: 0,
          achieved_weight: 0,
          required_total: 0,
          required_met: 0,
          raw_weighted_score: 0,
          cap_applied: false,
        },
        inferred_skills: [],
      }),
    };
    const scanner = { scan: jest.fn().mockReturnValue([]) };
    const svc = new CvJdMatchService(
      llm as never,
      prompts as never,
      tracing as never,
      skillDiff as never,
      scanner as never,
    );
    const res = await svc.match('user-1', {
      cv_id: 'cv-1',
      cv_text: 'Frontend developer with ReactJS at FPT Software.',
      scoring_template_code: 'cv_jd_match_v1',
      target_role: 'frontend_developer',
    } as never);
    expect(skillDiff.diff).toHaveBeenCalledWith(
      expect.objectContaining({ target_band: 'fresher' }),
    );
    expect(res.parsed_response.rubric_band).toBe('fresher');
  });
});

/**
 * PR3 (JD-Intelligence v2) — the cv_jd_match_v2 path adds a THIRD guarded read: jd_dimensions_raw is
 * normalized onto parsed.jd_dimensions (un-quoted entries dropped, level coerced). The legacy v1
 * output (no such key) must still yield [] — non-breaking by construction.
 */
describe('CvJdMatchService — jd_dimensions extraction (PR3)', () => {
  const diffResult = {
    matched_skills: [],
    partial_skills: [],
    missing_skills: [],
    bonus_skills: [],
    unnormalized_cv_skills: [],
    unnormalized_jd_requirements: [],
    match_ratio: 0,
    required_coverage: 1,
    overall_score: 50,
    requirements_source: 'role_rubric',
    scoring_breakdown: {
      total_requirements: 0,
      matched_count: 0,
      partial_count: 0,
      missing_count: 0,
      weight_sum: 0,
      achieved_weight: 0,
      required_total: 0,
      required_met: 0,
      raw_weighted_score: 0,
      cap_applied: false,
    },
    inferred_skills: [],
  };

  const build = (parsedJson: unknown) => {
    const llm = {
      complete: jest.fn().mockResolvedValue({
        parsedJson,
        rawResponse: '{}',
        tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        estimatedCostUsd: 0,
        latencyMs: 1,
      }),
    };
    const prompts = {
      get: jest.fn().mockReturnValue({ code: 'cv_jd_match', version: 2, meta: { system: 's' } }),
      render: jest.fn().mockReturnValue('rendered'),
    };
    const tracing = {
      startAiRequest: jest.fn().mockResolvedValue('req-1'),
      saveAiResult: jest.fn().mockResolvedValue('res-1'),
      completeAiRequest: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };
    const skillDiff = { diff: jest.fn().mockReturnValue(diffResult) };
    const scanner = { scan: jest.fn().mockReturnValue([]) };
    const svc = new CvJdMatchService(
      llm as never,
      prompts as never,
      tracing as never,
      skillDiff as never,
      scanner as never,
    );
    return { svc };
  };

  // No jd_text → the content gate + off-topic guard are skipped; this isolates dimension parsing.
  const baseInput = {
    cv_id: 'cv-1',
    cv_text: 'Backend developer at FPT Software.',
    scoring_template_code: 'cv_jd_match_v2',
    target_role: 'backend_developer',
  };

  it('normalizes jd_dimensions_raw onto parsed.jd_dimensions, dropping un-quoted entries', async () => {
    const { svc } = build({
      cv_skills_raw: [{ name: 'Git' }],
      jd_requirements_raw: [{ name: 'Git' }],
      jd_dimensions_raw: [
        {
          dimension: 'seniority',
          level_hint: 'senior',
          importance_hint: 'REQUIRED',
          evidence_text: 'Senior, 5+ years',
        },
        { dimension: 'seniority', level_hint: 'JUNIOR' }, // no evidence_text → dropped
      ],
    });
    const res = await svc.match('user-1', { ...baseInput } as never);
    const dims = res.parsed_response.jd_dimensions ?? [];
    expect(dims).toHaveLength(1);
    expect(dims[0].dimension).toBe('seniority');
    expect(dims[0].level_hint).toBe('SENIOR'); // coerced to a JOB_LEVEL_RANK key
    expect(dims[0].importance).toBe('REQUIRED');
  });

  it('legacy v1 output without jd_dimensions_raw → parsed.jd_dimensions = []', async () => {
    const { svc } = build({
      cv_skills_raw: [{ name: 'Git' }],
      jd_requirements_raw: [{ name: 'Git' }],
    });
    const res = await svc.match('user-1', { ...baseInput } as never);
    expect(res.parsed_response.jd_dimensions).toEqual([]);
  });
});

describe('CvJdMatchService — extraction cache', () => {
  const diffResult = {
    matched_skills: [{ name: 'React', required_level: 3, cv_level: 4, importance: 'REQUIRED' }],
    partial_skills: [],
    missing_skills: [],
    bonus_skills: [],
    unnormalized_cv_skills: [],
    unnormalized_jd_requirements: [],
    match_ratio: 1,
    required_coverage: 1,
    overall_score: 88,
    requirements_source: 'jd',
    scoring_breakdown: {
      total_requirements: 1,
      matched_count: 1,
      partial_count: 0,
      missing_count: 0,
      weight_sum: 3,
      achieved_weight: 3,
      required_total: 1,
      required_met: 1,
      raw_weighted_score: 88,
      cap_applied: false,
    },
    inferred_skills: [],
  };

  const extraction = {
    cv_skills_raw: [
      { name: 'React', proficiency_hint: 'ADVANCED', evidence_text: 'Built React UI' },
    ],
    jd_requirements_raw: [
      { name: 'React', importance: 'REQUIRED', evidence_text: 'React is required' },
    ],
    jd_dimensions_raw: [],
    jd_dimensions: [],
  };

  const baseInput = {
    cv_id: 'cv-1',
    cv_text:
      'Frontend developer with React and TypeScript experience building production dashboards at FPT Software.',
    jd_text:
      'We are hiring a frontend developer to build React dashboards, maintain TypeScript components, collaborate with backend engineers, and improve product quality.',
    scoring_template_code: 'cv_jd_match_v1',
    target_role: 'frontend_developer',
  };

  const build = (opts?: { cacheRead?: unknown; llmExtraction?: unknown }) => {
    const llm = {
      complete: jest.fn().mockResolvedValue({
        parsedJson: opts?.llmExtraction ?? {
          cv_skills_raw: extraction.cv_skills_raw,
          jd_requirements_raw: extraction.jd_requirements_raw,
        },
        rawResponse: '{"ok":true}',
        tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        estimatedCostUsd: 0.001,
        latencyMs: 42,
        modelCode: 'gpt-5.4-mini',
      }),
    };
    const prompts = {
      get: jest.fn().mockReturnValue({ code: 'cv_jd_match_v1', version: 1, meta: { system: 's' } }),
      render: jest.fn().mockReturnValue('rendered'),
    };
    const tracing = {
      startAiRequest: jest.fn().mockResolvedValue('req-1'),
      saveAiResult: jest.fn().mockResolvedValue('res-1'),
      completeAiRequest: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };
    const skillDiff = { diff: jest.fn().mockReturnValue(diffResult) };
    const scanner = { scan: jest.fn().mockReturnValue([]) };
    const config = {
      get: jest.fn((key: string) => {
        const values: Record<string, string | boolean> = {
          'llm.providerDefault': 'openai',
          'llm.openai.modelDefault': 'gpt-5.4-mini',
          'cvJdMatch.extractionCacheEnabled': true,
        };
        return values[key];
      }),
    };
    const cache = {
      hashKey: jest.fn().mockReturnValue('cache-key'),
      read: jest.fn().mockResolvedValue(opts?.cacheRead ?? null),
      write: jest.fn().mockResolvedValue(undefined),
      recordHit: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new CvJdMatchService(
      llm as never,
      prompts as never,
      tracing as never,
      skillDiff as never,
      scanner as never,
      config as never,
      cache as never,
    );
    return { svc, llm, prompts, tracing, skillDiff, cache };
  };

  it('cache miss calls the LLM once, writes extraction, and persists the full match result', async () => {
    const { svc, llm, cache, tracing } = build();

    const res = await svc.match('user-1', baseInput as never);

    expect(cache.hashKey).toHaveBeenCalledWith(
      expect.objectContaining({
        cvText: baseInput.cv_text,
        jdText: baseInput.jd_text,
        templateCode: 'cv_jd_match_v1',
        provider: 'openai',
        modelCode: 'gpt-5.4-mini',
      }),
    );
    expect(cache.read).toHaveBeenCalledWith('cache-key');
    expect(llm.complete).toHaveBeenCalledTimes(1);
    expect(cache.write).toHaveBeenCalledWith(
      'cache-key',
      expect.objectContaining({
        cv_skills_raw: extraction.cv_skills_raw,
        jd_requirements_raw: extraction.jd_requirements_raw,
        jd_dimensions_raw: [],
        jd_dimensions: [],
      }),
      expect.objectContaining({
        provider: 'openai',
        modelCode: 'gpt-5.4-mini',
        templateCode: 'cv_jd_match_v1',
        promptTemplateVersion: 1,
      }),
    );
    expect(tracing.saveAiResult).toHaveBeenCalledWith(
      expect.objectContaining({
        parsedResponse: expect.objectContaining({ overall_score: 88 }),
      }),
    );
    expect(res.parsed_response.overall_score).toBe(88);
  });

  it('cache hit bypasses the LLM and completes tracing with zero tokens', async () => {
    const { svc, llm, cache, tracing } = build({ cacheRead: extraction });

    const res = await svc.match('user-1', baseInput as never);

    expect(llm.complete).not.toHaveBeenCalled();
    expect(cache.recordHit).toHaveBeenCalledWith('cache-key');
    expect(tracing.completeAiRequest).toHaveBeenCalledWith(
      'req-1',
      expect.objectContaining({
        status: 'SUCCESS',
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        modelCode: 'gpt-5.4-mini',
      }),
    );
    expect(res.parsed_response.overall_score).toBe(88);
  });

  it('off-topic JD guard still rejects cached extraction with zero JD requirements', async () => {
    const { svc, llm, tracing, skillDiff } = build({
      cacheRead: {
        cv_skills_raw: extraction.cv_skills_raw,
        jd_requirements_raw: [],
        jd_dimensions_raw: [],
        jd_dimensions: [],
      },
    });

    await expect(svc.match('user-1', baseInput as never)).rejects.toMatchObject({
      response: { code: 'JD_CONTENT_INSUFFICIENT' },
    });

    expect(llm.complete).not.toHaveBeenCalled();
    expect(skillDiff.diff).not.toHaveBeenCalled();
    expect(tracing.completeAiRequest).toHaveBeenCalledWith(
      'req-1',
      expect.objectContaining({ status: 'SUCCESS', totalTokens: 0 }),
    );
  });
});

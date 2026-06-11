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

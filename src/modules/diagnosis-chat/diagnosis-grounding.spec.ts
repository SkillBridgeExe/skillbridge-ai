import { CvReviewParsedResponse } from '../cv-review/dto/cv-review-response.dto';
import { SkillBridgeGapReport } from '../gap-report/gap-report.service';
import { GapItem } from '../gap-engine/gap-item';
import { ProgressReport } from '../gap-report/gap-progress';
import {
  buildDiagnosisFacts,
  DIAGNOSIS_DIMENSION_KEYS,
  DiagnosisFacts,
  groundDiagnosis,
  allowedNumberTokens,
  statProvenance,
  ungroundedNumbers,
  unverifiableClaim,
  REFUSAL_COPY,
} from './diagnosis-grounding';

/** Minimal CV review fixture — only the fields buildDiagnosisFacts reads matter; the rest is cast away. */
function makeReview(overrides: Partial<CvReviewParsedResponse> = {}): CvReviewParsedResponse {
  return {
    overall_score: 72,
    ats_rule_score: 65,
    llm_score_dimensions: {
      action_verbs: 14,
      skills_relevance: 12,
      experience: 16,
      education: 18,
    },
    rationale: {
      action_verbs: 'Strong verb-first bullets.',
      skills_relevance: 'Some JD skills are missing.',
      experience: 'Solid internship history.',
      education: 'Degree is relevant.',
    },
    top_summary: {
      headline: 'Solid CV, tighten skills.',
      prioritized_actions: ['Add Docker evidence', 'Quantify the API bullet', 'List TypeScript'],
    },
    ...overrides,
  } as unknown as CvReviewParsedResponse;
}

function makeGapItem(overrides: Partial<GapItem> = {}): GapItem {
  return {
    requirement_id: 'jd:hard_skill:docker',
    source: 'jd',
    type: 'hard_skill',
    canonical_name: 'docker',
    display_name: 'Docker',
    importance: 'REQUIRED',
    cv_status: 'missing',
    cv_level: null,
    required_level: 4,
    gap_levels: 4,
    satisfied_by: null,
    evidence_refs: [],
    evidence_risk: 'none',
    fixability: 'learn',
    market_demand: 60,
    severity: 0.5,
    confidence: 1,
    recommended_next_action: 'Học & bổ sung kỹ năng này',
    ...overrides,
  };
}

function makeGapReport(gapItems: GapItem[]): SkillBridgeGapReport {
  return { gap_items: gapItems } as unknown as SkillBridgeGapReport;
}

/** Minimal ProgressReport fixture — one closed transition, non-baseline, template unchanged. */
function makeProgress(overrides: Partial<ProgressReport> = {}): ProgressReport {
  return {
    baseline: false,
    prev_count: 2,
    curr_count: 1,
    gaps_closed: ['docker'],
    gaps_worsened: [],
    avg_severity_delta: -0.1,
    prev_score: 60,
    curr_score: 72,
    transitions: [
      {
        canonical_name: 'docker',
        display_name: 'Docker',
        prev_status: 'missing',
        curr_status: 'matched',
        kind: 'closed',
        prev_severity: 0.5,
        curr_severity: 0,
      },
    ],
    dimension_changes: [],
    evidence_recognized: [],
    strengths_kept: [],
    required_coverage_delta: null,
    template_changed: false,
    ...overrides,
  };
}

describe('buildDiagnosisFacts', () => {
  it('maps the real CV-review fields verbatim (numbers come ONLY from the record)', () => {
    const facts = buildDiagnosisFacts(makeReview(), makeGapReport([]));
    expect(facts.overall_score).toBe(72);
    expect(facts.ats_score).toBe(65);
    // four canonical dimensions, each with key + score20 + rationale read straight from the review
    expect(facts.dimensions).toEqual([
      { key: 'action_verbs', score20: 14, rationale: 'Strong verb-first bullets.' },
      { key: 'skills_relevance', score20: 12, rationale: 'Some JD skills are missing.' },
      { key: 'experience', score20: 16, rationale: 'Solid internship history.' },
      { key: 'education', score20: 18, rationale: 'Degree is relevant.' },
    ]);
    expect(facts.top_summary.prioritized_actions).toEqual([
      'Add Docker evidence',
      'Quantify the API bullet',
      'List TypeScript',
    ]);
  });

  it('maps gap_items verbatim to the allow-list shape', () => {
    const facts = buildDiagnosisFacts(makeReview(), makeGapReport([makeGapItem()]));
    expect(facts.gap_items).toEqual([
      {
        requirement_id: 'jd:hard_skill:docker',
        display_name: 'Docker',
        cv_status: 'missing',
        severity: 0.5,
        market_demand: 60,
        recommended_next_action: 'Học & bổ sung kỹ năng này',
        fixability: 'learn',
      },
    ]);
  });

  it('caps gap_items at the top-N by severity (already severity-ranked input preserved + truncated)', () => {
    const items = Array.from({ length: 12 }, (_, i) =>
      makeGapItem({
        requirement_id: `jd:hard_skill:s${i}`,
        canonical_name: `s${i}`,
        display_name: `Skill ${i}`,
        severity: (12 - i) / 12, // descending, already ranked
      }),
    );
    const facts = buildDiagnosisFacts(makeReview(), makeGapReport(items));
    expect(facts.gap_items).toHaveLength(8);
    // keeps the highest-severity ones, in order
    expect(facts.gap_items[0].requirement_id).toBe('jd:hard_skill:s0');
    expect(facts.gap_items[7].requirement_id).toBe('jd:hard_skill:s7');
  });

  it('CV-only path (no gap report) → gap_items is an empty array, never throws', () => {
    const facts = buildDiagnosisFacts(makeReview(), null);
    expect(facts.gap_items).toEqual([]);
    expect(facts.overall_score).toBe(72);
  });

  it('adds recent other-match summaries when provided, without created_at noise', () => {
    const otherMatchesFromPlatform = [
      {
        jd_title: 'Frontend Developer',
        overall_score: 72,
        top_gaps: ['React', 'TypeScript', 'Testing'],
        created_at: '2026-07-02T08:00:00.000Z',
      },
      {
        jd_title: null,
        overall_score: null,
        top_gaps: ['Docker'],
        created_at: '2026-07-01T08:00:00.000Z',
      },
    ];

    const facts = buildDiagnosisFacts(
      makeReview(),
      makeGapReport([]),
      null,
      otherMatchesFromPlatform,
    );

    expect(facts.other_matches).toEqual([
      { jd_title: 'Frontend Developer', overall_score: 72, top_gaps: ['React', 'TypeScript'] },
      { jd_title: null, overall_score: null, top_gaps: ['Docker'] },
    ]);
  });

  it('omits other_matches when the list is empty or absent', () => {
    expect(buildDiagnosisFacts(makeReview(), makeGapReport([]))).not.toHaveProperty(
      'other_matches',
    );
    expect(buildDiagnosisFacts(makeReview(), makeGapReport([]), null, [])).not.toHaveProperty(
      'other_matches',
    );
  });

  it('never leaks match_id/cv_id into facts.other_matches even when the platform-supplied input carries them (LLM must never see ids)', () => {
    const otherMatchesFromPlatform = [
      {
        match_id: 'match-abc',
        cv_id: 'cv-abc',
        jd_title: 'Frontend Developer',
        overall_score: 72,
        top_gaps: ['React'],
        created_at: '2026-07-02T08:00:00.000Z',
      },
    ];

    const facts = buildDiagnosisFacts(
      makeReview(),
      makeGapReport([]),
      null,
      otherMatchesFromPlatform,
    );

    expect(facts.other_matches).toEqual([
      { jd_title: 'Frontend Developer', overall_score: 72, top_gaps: ['React'] },
    ]);
    expect(JSON.stringify(facts)).not.toContain('match-abc');
    expect(JSON.stringify(facts)).not.toContain('cv-abc');
  });

  it('missing/empty review dimension fields degrade to empty arrays, never throw', () => {
    const facts = buildDiagnosisFacts({} as unknown as CvReviewParsedResponse, null);
    expect(facts.dimensions).toEqual([]);
    expect(facts.top_summary.prioritized_actions).toEqual([]);
    expect(facts.gap_items).toEqual([]);
    // numeric fields that are absent become null (never NaN / undefined)
    expect(facts.overall_score).toBeNull();
    expect(facts.ats_score).toBeNull();
  });

  it('exposes the four canonical dimension keys', () => {
    expect(DIAGNOSIS_DIMENSION_KEYS).toEqual([
      'action_verbs',
      'skills_relevance',
      'experience',
      'education',
    ]);
  });
});

describe('buildDiagnosisFacts — progress (B6)', () => {
  it('progress (non-baseline) with a closed gap → facts.progress carries closed names + rounded score_delta', () => {
    const progress = makeProgress();
    const facts = buildDiagnosisFacts(makeReview(), makeGapReport([]), progress);
    expect(facts.progress).toEqual({
      closed: ['Docker'],
      improved: [],
      new_gaps: [],
      worsened: [],
      score_delta: 12,
    });
  });

  it('worsened transitions reach the facts — hidden on the banner by design, but the advisor answers honestly when asked', () => {
    const facts = buildDiagnosisFacts(
      makeReview(),
      makeGapReport([]),
      makeProgress({
        transitions: [
          {
            canonical_name: 'sql',
            display_name: 'SQL',
            prev_status: 'partial',
            curr_status: 'missing',
            kind: 'worsened',
            prev_severity: 0.3,
            curr_severity: 0.6,
          },
        ],
      }),
    );
    expect(facts.progress?.worsened).toEqual(['SQL']);
    expect(facts.progress?.closed).toEqual([]);
  });

  it('progress omitted / null / baseline → facts has NO progress key (chat behaves exactly as today)', () => {
    const factsNoArg = buildDiagnosisFacts(makeReview(), makeGapReport([]));
    expect(factsNoArg).not.toHaveProperty('progress');

    const factsNull = buildDiagnosisFacts(makeReview(), makeGapReport([]), null);
    expect(factsNull).not.toHaveProperty('progress');

    const factsBaseline = buildDiagnosisFacts(
      makeReview(),
      makeGapReport([]),
      makeProgress({ baseline: true }),
    );
    expect(factsBaseline).not.toHaveProperty('progress');
  });

  it('score_delta is null when either score is missing (never a fabricated number)', () => {
    const facts = buildDiagnosisFacts(
      makeReview(),
      makeGapReport([]),
      makeProgress({ prev_score: null }),
    );
    expect(facts.progress?.score_delta).toBeNull();
  });
});

describe('buildDiagnosisFacts — learning completed pending verification (V2, Wave VALUE_CHAIN)', () => {
  it('progress.learning_completed → facts field the LLM can phrase as "đã học xong X — sẽ kiểm chứng ở lần quét tới"', () => {
    const facts = buildDiagnosisFacts(
      makeReview(),
      makeGapReport([]),
      makeProgress({ learning_completed: ['react', 'sql'] }),
    );
    expect(facts.learning_completed_pending_verification).toEqual(['react', 'sql']);
    // Serialized verbatim into the LLM-bound facts JSON — the honest framing travels in the key name
    // itself (prompts/*.md untouched).
    expect(JSON.stringify(facts)).toContain('learning_completed_pending_verification');
  });

  it('BASELINE progress still surfaces it (learn-then-rescan window: facts.progress absent, field present)', () => {
    const facts = buildDiagnosisFacts(
      makeReview(),
      makeGapReport([]),
      makeProgress({ baseline: true, learning_completed: ['react'] }),
    );
    expect(facts).not.toHaveProperty('progress');
    expect(facts.learning_completed_pending_verification).toEqual(['react']);
  });

  it('no learning_completed → key absent + facts byte-identical to today', () => {
    const base = buildDiagnosisFacts(makeReview(), makeGapReport([]), makeProgress());
    expect(base).not.toHaveProperty('learning_completed_pending_verification');
    const withEmpty = buildDiagnosisFacts(
      makeReview(),
      makeGapReport([]),
      makeProgress({ learning_completed: [] }),
    );
    expect(JSON.stringify(withEmpty)).toBe(JSON.stringify(base));
  });

  it('capped at 8 entries for the prompt (mirrors the other facts lists)', () => {
    const many = Array.from({ length: 12 }, (_, i) => `skill_${i}`);
    const facts = buildDiagnosisFacts(
      makeReview(),
      makeGapReport([]),
      makeProgress({ learning_completed: many }),
    );
    expect(facts.learning_completed_pending_verification).toHaveLength(8);
    expect(facts.learning_completed_pending_verification?.[0]).toBe('skill_0');
  });
});

describe('groundDiagnosis (anti-fabrication boundary)', () => {
  const facts = buildDiagnosisFacts(makeReview(), makeGapReport([makeGapItem()]));

  it('keeps valid citations but replaces fabricated prose with the warm refusal + verified hook', () => {
    const result = groundDiagnosis(
      {
        message: 'Your ATS is 98 and you should learn Kubernetes immediately.',
        cited_dimension: 'skills_relevance',
        cited_gap_id: 'jd:hard_skill:docker',
        suggested_next_step: 'Buy this Kubernetes course.',
      },
      facts,
    );
    // Phase A: the kill serves the refusal, hooked on the cited gap (gap outranks dimension).
    expect(result.answer).toContain('dữ liệu đã xác minh');
    expect(result.answer).toContain('Docker');
    expect(result.answer).not.toContain('98');
    expect(result.answer).not.toContain('Kubernetes');
    expect(result.cited_dimension).toBe('skills_relevance');
    expect(result.cited_gap_id).toBe('jd:hard_skill:docker');
    expect(result.suggested_next_step).toBe('Học & bổ sung kỹ năng này');
  });

  // Advisor v3: an uncited answer is SERVED, not discarded. A citation is a scroll target; requiring
  // one silently killed every turn with nothing to point at — memory ("what did I just say?"),
  // clarifying questions, greetings — and bought no protection, since the gate reads a metadata field
  // and never the prose. The number + unverifiable-claim gates are what guard the words.
  it('SERVES an uncited answer (a citation is a scroll target, not a licence to speak)', () => {
    const result = groundDiagnosis({ message: 'Bạn vừa nói bạn nhắm vị trí AI Engineer.' }, facts);
    expect(result.answer).toBe('Bạn vừa nói bạn nhắm vị trí AI Engineer.');
    expect(result.cited_dimension).toBeUndefined();
    expect(result.cited_gap_id).toBeUndefined();
  });

  it('DROPS cited_dimension that is not a real dimension key (prose still served)', () => {
    const result = groundDiagnosis({ message: 'ok', cited_dimension: 'charisma' }, facts);
    // The fabricated citation never reaches the wire — that is the guarantee that matters.
    expect(result.cited_dimension).toBeUndefined();
    expect(result.answer).toBe('ok');
  });

  it('DROPS cited_gap_id that is not in facts.gap_items requirement_ids (prose still served)', () => {
    const result = groundDiagnosis(
      { message: 'ok', cited_gap_id: 'jd:hard_skill:kubernetes' },
      facts,
    );
    expect(result.cited_gap_id).toBeUndefined();
    expect(result.answer).toBe('ok');
  });

  it('strips a planted raw URL from the message and the suggested_next_step', () => {
    const result = groundDiagnosis(
      {
        message: 'Take this course at https://evil.example.com/hack now.',
        cited_gap_id: 'jd:hard_skill:docker',
        suggested_next_step: 'See www.spam.io/deal for more.',
      },
      facts,
    );
    expect(result.answer).not.toContain('evil.example.com');
    expect(result.answer).not.toContain('http');
    expect(result.suggested_next_step).not.toContain('spam.io');
  });

  it('a killed comparison turn keeps the VERIFIED comparison in the refusal (the user still gets their answer)', () => {
    const factsWithOtherMatches = buildDiagnosisFacts(
      makeReview(),
      makeGapReport([makeGapItem()]),
      null,
      [
        { jd_title: 'Frontend Developer', overall_score: 72, top_gaps: ['React', 'TypeScript'] },
        { jd_title: 'Backend Developer', overall_score: 64, top_gaps: ['Docker'] },
      ],
    );

    const result = groundDiagnosis(
      {
        message: 'The frontend JD is the best and the salary is 2000 USD.',
        cited_other_match_index: 1,
      },
      factsWithOtherMatches,
      'en',
    );

    // Phase A: the salary invention is refused BY NAME, warmly — not answered with a fact template.
    expect(result.answer).toContain('blind spot');
    expect(result.answer).toContain('Frontend Developer');
    expect(result.answer).toContain('72');
    expect(result.answer).toContain('React');
    expect(result.answer).toContain('TypeScript');
    expect(result.answer).not.toContain('2000');
    // The citation survives so the FE still scrolls to the compared match.
    expect(result.cited_other_match_index).toBe(1);
    // The refusal always leaves a verified forward step on the table.
    expect(result.suggested_next_step).toBe('Add Docker evidence');
  });

  it('drops fabricated other-match indexes and falls back to normal grounded advice', () => {
    const factsWithOtherMatches = buildDiagnosisFacts(
      makeReview(),
      makeGapReport([makeGapItem()]),
      null,
      [{ jd_title: 'Frontend Developer', overall_score: 72, top_gaps: ['React'] }],
    );

    const result = groundDiagnosis(
      {
        message: 'JD 99 is great.',
        cited_other_match_index: 99,
      },
      factsWithOtherMatches,
      'en',
    );

    expect(result.answer).toContain('Add Docker evidence');
    expect(result.answer).not.toContain('JD 99');
  });

  it('exposes the validated 1-based cited_other_match_index on the result — LIVE BUG: this was computed for grounding but never forwarded to the wire (out-of-range → undefined)', () => {
    const factsWithOtherMatches = buildDiagnosisFacts(
      makeReview(),
      makeGapReport([makeGapItem()]),
      null,
      [
        { jd_title: 'Frontend Developer', overall_score: 72, top_gaps: ['React'] },
        { jd_title: 'Backend Developer', overall_score: 64, top_gaps: ['Docker'] },
      ],
    );

    const valid = groundDiagnosis(
      { message: 'The backend JD looks better for you.', cited_other_match_index: 2 },
      factsWithOtherMatches,
    );
    expect(valid.cited_other_match_index).toBe(2);

    const outOfRange = groundDiagnosis(
      { message: 'JD 99 is great.', cited_other_match_index: 99 },
      factsWithOtherMatches,
    );
    expect(outOfRange.cited_other_match_index).toBeUndefined();

    const absent = groundDiagnosis({ message: 'ok' }, factsWithOtherMatches);
    expect(absent.cited_other_match_index).toBeUndefined();
  });

  it('empty / parse-failed model output → deterministic grounded fallback built from top_summary (never a 500)', () => {
    const fallback = groundDiagnosis(null, facts);
    expect(typeof fallback.answer).toBe('string');
    expect(fallback.answer.length).toBeGreaterThan(0);
    // the fallback is sourced from the user's own prioritized actions
    expect(fallback.answer).toContain('Add Docker evidence');
    expect(fallback.cited_dimension).toBeUndefined();
    expect(fallback.cited_gap_id).toBeUndefined();
  });

  it('empty message string → fallback', () => {
    const fallback = groundDiagnosis({ message: '   ' }, facts);
    expect(fallback.answer.length).toBeGreaterThan(0);
    expect(fallback.answer).toContain('Add Docker evidence');
  });

  it('fallback with no prioritized actions is still honest non-empty prose (no crash)', () => {
    const bareFacts = buildDiagnosisFacts({} as unknown as CvReviewParsedResponse, null);
    const fallback = groundDiagnosis(null, bareFacts);
    expect(typeof fallback.answer).toBe('string');
    expect(fallback.answer.length).toBeGreaterThan(0);
  });

  // P1-C — the deterministic fallback must answer in the user's language (was hardcoded Vietnamese,
  // so English users got a Vietnamese answer on EVERY Gemini timeout/429/empty-parse).
  describe('fallback language (P1-C)', () => {
    /** Vietnamese marker words present ONLY in the vi fallback framing — used to assert the en path is NOT vi. */
    const VI_MARKERS = ['Dựa trên', 'của bạn', 'nên ưu tiên', 'chẩn đoán'];

    it('language="en" → fallback is English (carries the user own prioritized action, no Vietnamese framing)', () => {
      const result = groundDiagnosis(null, facts, 'en');
      // still grounded in the user's OWN prioritized action (verbatim from FACTS)
      expect(result.answer).toContain('Add Docker evidence');
      // English framing — none of the Vietnamese marker words leak through
      for (const marker of VI_MARKERS) {
        expect(result.answer).not.toContain(marker);
      }
    });

    it('language="vi" → fallback is Vietnamese (the default framing)', () => {
      const result = groundDiagnosis(null, facts, 'vi');
      expect(result.answer).toContain('Add Docker evidence');
      expect(result.answer).toContain('Dựa trên');
    });

    it('language undefined → defaults to Vietnamese', () => {
      const result = groundDiagnosis(null, facts);
      expect(result.answer).toContain('Dựa trên');
    });

    it('empty-message fallback also honors language="en"', () => {
      const result = groundDiagnosis({ message: '   ' }, facts, 'en');
      expect(result.answer).toContain('Add Docker evidence');
      for (const marker of VI_MARKERS) {
        expect(result.answer).not.toContain(marker);
      }
    });

    it('English "no data" fallback (no prioritized actions) is English, not the Vietnamese default', () => {
      const bareFacts = buildDiagnosisFacts({} as unknown as CvReviewParsedResponse, null);
      const result = groundDiagnosis(null, bareFacts, 'en');
      expect(result.answer.length).toBeGreaterThan(0);
      for (const marker of VI_MARKERS) {
        expect(result.answer).not.toContain(marker);
      }
    });
  });
});

/**
 * Advisor v2 — grounding is a VERIFIER, not a replacer. When the model's message passes every
 * deterministic gate (valid citation + every number token exists in FACTS + URL strip), the user
 * gets the model's own phrasing (synthesis, comparisons, prioritization) instead of a canned
 * template. Any gate failure keeps the old template/fallback behavior byte-for-byte.
 */
describe('groundDiagnosis — Advisor v2 (serve verified model prose)', () => {
  const facts = buildDiagnosisFacts(makeReview(), makeGapReport([makeGapItem()]));
  const factsWithOtherMatches = buildDiagnosisFacts(
    makeReview(),
    makeGapReport([makeGapItem()]),
    null,
    [
      { jd_title: 'Frontend Developer', overall_score: 72, top_gaps: ['React', 'TypeScript'] },
      { jd_title: 'Backend Developer', overall_score: 64, top_gaps: ['Docker'] },
    ],
  );

  it('serves the model message verbatim when the citation is valid and every number is grounded', () => {
    const message =
      'Điểm skills_relevance của bạn đang ở 12/20 — thấp nhất trong 4 nhóm. Ưu tiên bổ sung bằng chứng Docker trước.';
    const result = groundDiagnosis(
      { message, cited_dimension: 'skills_relevance', cited_gap_id: 'jd:hard_skill:docker' },
      facts,
    );
    expect(result.answer).toBe(message);
    expect(result.cited_dimension).toBe('skills_relevance');
    expect(result.cited_gap_id).toBe('jd:hard_skill:docker');
  });

  it('serves a comparison CONCLUSION over other matches (the "JD nào hợp tôi nhất" case)', () => {
    const message =
      'JD Frontend Developer đang hợp bạn nhất (72/100 so với 64/100 của Backend) — gap còn lại là React và TypeScript.';
    const result = groundDiagnosis({ message, cited_other_match_index: 1 }, factsWithOtherMatches);
    expect(result.answer).toBe(message);
    expect(result.cited_other_match_index).toBe(1);
  });

  it('a single ungrounded number sinks the message back to the template (no fabricated scores)', () => {
    const result = groundDiagnosis(
      {
        message: 'skills_relevance của bạn là 19/20, rất tốt!',
        cited_dimension: 'skills_relevance',
      },
      facts,
    );
    expect(result.answer).not.toContain('19');
    expect(result.answer).toContain('12/20'); // template built from FACTS
  });

  it('counts stated inside FACTS strings are legal for the model to reuse', () => {
    // rationale strings are verified facts — numbers inside them ("some JD skills") may be echoed.
    const factsWithCounts = buildDiagnosisFacts(
      makeReview({
        rationale: {
          action_verbs: 'ok',
          skills_relevance: 'Khớp 4/12 kỹ năng trọng yếu.',
          experience: 'ok',
          education: 'ok',
        },
      } as never),
      makeGapReport([makeGapItem()]),
    );
    const message = 'Bạn mới khớp 4/12 kỹ năng trọng yếu — nên vá Docker trước.';
    const result = groundDiagnosis(
      { message, cited_dimension: 'skills_relevance' },
      factsWithCounts,
    );
    expect(result.answer).toBe(message);
  });

  it('serves the model suggested_next_step when grounded, keeps citations intact', () => {
    const result = groundDiagnosis(
      {
        message: 'Docker đang là gap ưu tiên cao nhất của bạn.',
        cited_gap_id: 'jd:hard_skill:docker',
        suggested_next_step: 'Thêm một dự án dùng Docker vào CV',
      },
      facts,
    );
    expect(result.answer).toBe('Docker đang là gap ưu tiên cao nhất của bạn.');
    expect(result.suggested_next_step).toBe('Thêm một dự án dùng Docker vào CV');
  });

  it('an ungrounded suggested_next_step is replaced by the verified next action, message still served', () => {
    const result = groundDiagnosis(
      {
        message: 'Docker đang là gap ưu tiên cao nhất của bạn.',
        cited_gap_id: 'jd:hard_skill:docker',
        suggested_next_step: 'Học 5 khóa Kubernetes ngay',
      },
      facts,
    );
    expect(result.answer).toBe('Docker đang là gap ưu tiên cao nhất của bạn.');
    expect(result.suggested_next_step).toBe('Học & bổ sung kỹ năng này');
  });

  it('URL-strips a served model message (backstop still applies to verified prose)', () => {
    const result = groundDiagnosis(
      {
        message: 'Docker là gap chính — xem thêm tại https://sketchy.example.com/course nhé.',
        cited_gap_id: 'jd:hard_skill:docker',
      },
      facts,
    );
    expect(result.answer).toContain('Docker là gap chính');
    expect(result.answer).not.toContain('sketchy.example.com');
  });

  // The admission copy still matters — but only where the advisor GENUINELY has no answer: an
  // unparseable / empty model output. Under v3 an uncited-but-sound answer is no longer routed here
  // (that misread "the model didn't cite" as "the model can't answer" and produced this apology for
  // perfectly good replies).
  it('honest fallback ADMITS it cannot answer when the model output is unusable', () => {
    const vi = groundDiagnosis(null, facts);
    expect(vi.answer).toContain('chưa đủ dữ kiện đã xác minh');
    expect(vi.answer).toContain('Add Docker evidence'); // still serves the verified priorities

    const en = groundDiagnosis(null, facts, 'en');
    expect(en.answer).toContain("can't answer that confidently");
    expect(en.answer).toContain('Add Docker evidence');
  });
});

/**
 * Advisor v3 gates. Measured over 25 adversarial multi-turn exchanges against the real model:
 *  - the citation requirement made memory/meta questions structurally unanswerable (20% of turns),
 *  - ordinal markers "(1) (2)" were read as fabricated numbers, so enumerated advice — which the
 *    prompt explicitly asks for — was replaced by a template. The fallback writes "(1) …" itself,
 *    so the gate rejected its own code's output,
 *  - and the model, pushed for a percentile, graded the candidate against other people ("mức trung
 *    bình khá", "chưa ở nhóm nổi bật") with no peer data anywhere in FACTS. No digits → invisible.
 */
describe('groundDiagnosis — Advisor v3 gates', () => {
  // TWO gaps, and no digit inside any name. Both halves are load-bearing against a VACUOUS suite:
  // with ONE gap, gap_items.length seeds "1" into the allowed set, so every "chọn 1 việc" case below
  // passed whether or not the advice-noun exemption existed at all — the test could not fail. And a
  // name like "K8s" leaks "8" in through the numerals-inside-fact-strings rule, which silently
  // legalises a fabricated dimension score of 8. Keep this fixture free of both.
  const facts = buildDiagnosisFacts(
    makeReview(),
    makeGapReport([
      makeGapItem(),
      makeGapItem({
        requirement_id: 'jd:hard_skill:kubernetes',
        canonical_name: 'kubernetes',
        display_name: 'Kubernetes',
      }),
    ]),
  );

  it('the fixture cannot make these tests pass by luck', () => {
    const allowed = allowedNumberTokens(facts);
    for (const digit of ['1', '5', '6', '7', '8']) expect(allowed.has(digit)).toBe(false);
  });

  describe('ordinal list markers are formatting, not claims', () => {
    it('serves an enumerated answer — "(1) … (2) …" is not a fabricated number', () => {
      const message = 'Ưu tiên: (1) thêm số liệu; (2) bổ sung kỹ năng; (3) sửa động từ.';
      const result = groundDiagnosis({ message, cited_dimension: 'skills_relevance' }, facts);
      expect(result.answer).toBe(message);
    });

    it('serves a line-start numbered list', () => {
      const message = 'Làm theo thứ tự:\n1. Sửa bullet.\n2. Học Docker.';
      const result = groundDiagnosis({ message, cited_dimension: 'skills_relevance' }, facts);
      expect(result.answer).toBe(message);
    });

    it("the code's own fallback copy passes the number gate it is judged by", () => {
      // The deterministic fallback enumerates "(1) …; (2) …" — it must not be self-rejecting.
      const fb = groundDiagnosis(null, facts).answer;
      const result = groundDiagnosis({ message: fb, cited_dimension: 'skills_relevance' }, facts);
      expect(result.answer).toBe(fb);
    });

    // An earlier cut treated "(N)" as a marker ANYWHERE, so bracketing any quantity erased it from
    // the number gate while the ORIGINAL text still shipped — "(91)/100" was served, bare "91/100"
    // was blocked. That is the product's whole numeric surface, opened by a formatting choice the
    // prompt itself encourages. Nothing is stripped any more: the gate reads the text that ships.
    it.each([
      ['a bracketed score', 'CV của bạn đạt (91)/100.'],
      ['a bracketed salary', 'Bạn nhắm (35) triệu/tháng nhé.'],
      ['a bracketed duration', 'Cần thêm (37) tháng kinh nghiệm.'],
      ['a bracketed count', 'Bạn cần (37) dự án nữa.'],
      // Single-digit marker SHAPE aimed at a scale — the same laundering with a smaller number.
      ['a bracketed single-digit score', 'CV của bạn đạt (9)/100.'],
    ])('refuses %s — brackets are not a licence to invent numbers', (_label, message) => {
      expect(groundDiagnosis({ message }, facts).answer).not.toBe(message);
    });

    // The SAME laundering survived the bracket fix on the "[;:,]" branch: a marker was anything at a
    // clause boundary, so "Tổng điểm CV của bạn: 91." — the most natural way a model states a score —
    // was read as the marker "91." and erased from the check while shipping verbatim. No strip now.
    it.each([
      ['after a colon', 'Tổng điểm CV của bạn: 91. Bạn nên sửa phần skills.'],
      ['after a semicolon', 'Docker là gap chính; 85. là điểm ATS hiện tại của bạn.'],
      ['a single digit after a colon', 'Điểm skills_relevance của bạn: 9. Khá thấp.'],
    ])('refuses a score dressed as a list marker (%s)', (_label, message) => {
      expect(
        groundDiagnosis({ message, cited_dimension: 'skills_relevance' }, facts).answer,
      ).not.toBe(message);
    });

    // Reading "(N)" as a marker ANYWHERE was the bracket laundering again, one digit down: a
    // bracketed single digit next to a metric name reads as a score to the user and as formatting to
    // the gate, and the ORIGINAL text ships either way. An enumeration ascends from 1; a score does
    // not — so "(N)" is only formatting when "(N-1)" is already above it.
    it.each([
      ['a dimension score', 'Mục skills_relevance của bạn (8) nên được cải thiện.'],
      ['an ATS score', 'Điểm ATS của bạn (7) là hơi thấp.'],
      ['an English score', 'Your ATS score (8) is holding you back.'],
      // A real marker earlier must not legalise a fabricated score later in the same message.
      ['a score trailing a real run', 'Ưu tiên: (1) sửa bullet. Điểm ATS của bạn (8) là thấp.'],
      // Same shape at line start: a bare digit answering "mấy điểm?" is not a list of one.
      ['a line-start score', '8. Bạn cần bổ sung động từ mạnh.'],
    ])(
      'refuses %s dressed as an ordinal marker — a marker ascends, a score does not',
      (_l, message) => {
        expect(
          groundDiagnosis({ message, cited_dimension: 'skills_relevance' }, facts).answer,
        ).not.toBe(message);
      },
    );

    it('still rejects a fabricated number that merely sits near a marker', () => {
      const message = '(1) Bạn cần 7 năm kinh nghiệm nữa.';
      const result = groundDiagnosis({ message, cited_dimension: 'skills_relevance' }, facts);
      expect(result.answer).not.toBe(message);
      expect(result.answer).toContain('/20'); // fell through to the verified template
    });

    it('still rejects a bare mid-sentence number that is not a marker', () => {
      const message = 'Điểm của bạn tăng 7. Rất tốt.';
      const result = groundDiagnosis({ message, cited_dimension: 'skills_relevance' }, facts);
      expect(result.answer).not.toBe(message);
    });
  });

  /**
   * Everyday quantities in advice. Measured live: "mình có thể giúp bạn chọn đúng 1 việc để làm ngay
   * hôm nay" was replaced by the fact template because "1" is in no FACTS array's length. Which small
   * digits were speakable was luck per user — "2" legal with 2 gaps, fabricated with 5 — so the
   * advisor's ability to give plain advice depended on the shape of someone's gap report.
   */
  describe('the quantity ONE over an advice noun is not a claim about the record', () => {
    it.each([
      ['the measured failure', 'Mình có thể giúp bạn chọn đúng 1 việc để làm ngay hôm nay.'],
      ['a quantity mid-advice', 'Mỗi bullet chỉ nên có 1 động từ mạnh ở đầu câu.'],
      ['an English advice noun', 'Pick 1 thing to fix today.'],
    ])('serves %s', (_label, message) => {
      expect(groundDiagnosis({ message }, facts).answer).toBe(message);
    });

    // The exemption is an ALLOW-list of advice nouns precisely so these keep failing CLOSED: a count
    // of the user's OWN record is a claim, and no digit-level gate can verify it.
    it.each([
      ['a fabricated project count', 'Bạn cần thêm 7 dự án nữa.'],
      ['a fabricated skill count', 'Bạn còn thiếu 6 kỹ năng cho JD này.'],
      ['a fabricated experience claim', 'Bạn cần 7 năm kinh nghiệm nữa.'],
      ['a small fabricated metric', 'Chỉ 9% bullet của bạn có số liệu.'],
      ['a fabricated score on a scale', 'skills_relevance của bạn đang ở 9/20.'],
    ])('refuses %s — an unlisted noun falls back to the gate', (_label, message) => {
      expect(groundDiagnosis({ message }, facts).answer).not.toBe(message);
    });

    // The LISTED nouns are the dangerous ones, not the safe ones: "việc/chỗ/điều" are plain synonyms
    // for a gap item and "bullet/câu/động từ" are the CV's own contents, so exempting 1-9 over them
    // re-opened the threat model's headline case ("bạn có 5 gap", real answer 2) through the very
    // list that was meant to buy naturalness. Only "1" was ever measured lost, so only "1" is bought
    // back — and "1 <noun>" cannot be a score, a percentage or a salary.
    it.each([
      ['a fabricated task count', 'Bạn còn 5 việc phải sửa trong CV trước khi nộp.'],
      ['a fabricated bullet count', 'CV của bạn có 6 bullet chưa có số liệu.'],
      ['a fabricated verb count', 'Bạn thiếu 8 động từ mạnh trong phần kinh nghiệm.'],
      ['a fabricated gap synonym count', 'Còn 5 chỗ cần sửa gấp trong CV.'],
      ['a fabricated sentence count', 'Mình đếm được 5 câu đang viết ở dạng bị động.'],
      ['a fabricated issue count', 'Có 6 điều trong CV đang kéo điểm bạn xuống.'],
    ])('refuses %s — a listed noun buys "1", never a count', (_label, message) => {
      expect(
        groundDiagnosis({ message, cited_dimension: 'skills_relevance' }, facts).answer,
      ).not.toBe(message);
    });
  });

  describe('unverifiable claims about OTHER people are refused (the gate has no digits to see)', () => {
    const cited = { cited_dimension: 'skills_relevance' as const };

    it.each([
      ['peer grade', 'CV của bạn đang ở mức trung bình khá cho vị trí này.'],
      ['peer comparison', 'So với các ứng viên khác thì hồ sơ này ổn.'],
      ['market baseline', 'Hồ sơ của bạn thấp hơn mặt bằng chung của ngành.'],
      ['ranking', 'Bạn đang ở top 30% ứng viên.'],
      ['vibes ranking', 'Hồ sơ này chưa ở nhóm nổi bật, nhưng cũng không phải yếu.'],
      ['hire odds', 'Khả năng đậu của bạn là khá cao.'],
      ['salary', 'Mức lương cho vị trí này thường khá tốt.'],
    ])('refuses to serve a %s claim', (_label, message) => {
      const result = groundDiagnosis({ message, ...cited }, facts);
      expect(result.answer).not.toBe(message);
    });

    // `language` is a client-supplied wire field and 'en' is a first-class path — a Vietnamese-only
    // deny-list is a no-op there, i.e. exactly the axis this gate exists for, wide open.
    it.each([
      ['peer grade', 'Your CV is fairly average for this role compared to other candidates.'],
      ['hire odds', 'Your chances of getting hired here are quite high.'],
      ['salary', 'The salary for this role is usually competitive.'],
    ])('refuses a %s claim in English too', (_label, message) => {
      expect(groundDiagnosis({ message, ...cited }, facts, 'en').answer).not.toBe(message);
    });

    it.each([
      ['one word inserted', 'CV của bạn đang ở mức độ trung bình cho vị trí này.'],
      ['an unlisted quantifier', 'Hầu hết ứng viên cho vị trí này đã có Docker.'],
      ['a real number re-aimed at people', '60% ứng viên cho vị trí này đã có Docker.'],
    ])('refuses a peer claim that dodges the obvious phrasing (%s)', (_label, message) => {
      expect(groundDiagnosis({ message, ...cited }, facts).answer).not.toBe(message);
    });

    it('does NOT eat "mức khác" — a word boundary, not a grade', () => {
      const message = 'Các gap của bạn đang ở mức khác nhau: Docker mới là missing.';
      expect(groundDiagnosis({ message, cited_gap_id: 'jd:hard_skill:docker' }, facts).answer).toBe(
        message,
      );
    });

    it('holds suggested_next_step to the SAME claim gate as the message', () => {
      const result = groundDiagnosis(
        {
          message: 'Docker đang là gap ưu tiên cao nhất của bạn.',
          cited_gap_id: 'jd:hard_skill:docker',
          suggested_next_step: 'Bổ sung Docker để hơn mặt bằng chung của các ứng viên khác.',
        },
        facts,
      );
      // The chip the user taps must not carry a claim the message itself would be refused for.
      expect(result.suggested_next_step).not.toContain('mặt bằng chung');
      expect(result.suggested_next_step).toBe('Học & bổ sung kỹ năng này'); // verified default
    });

    it('ALLOWS comparing two entries that both live in FACTS (that is grounded, not guessing)', () => {
      const message =
        'Trong các gap của bạn, Docker có nhu cầu thị trường cao hơn các mục còn lại, nên ưu tiên nó trước.';
      const result = groundDiagnosis({ message, cited_gap_id: 'jd:hard_skill:docker' }, facts);
      expect(result.answer).toBe(message);
    });

    it('ALLOWS ordinary advice that merely contains the word "khá"', () => {
      const message = 'Phần Education của bạn khá tốt, nên giữ nguyên và tập trung chỗ khác.';
      const result = groundDiagnosis({ message, cited_dimension: 'education' }, facts);
      expect(result.answer).toBe(message);
    });
  });

  describe('a percentage may only be ATTACHED to what FACTS attach it to (phrase provenance)', () => {
    // market_demand is the ONE percentage in FACTS, so it is the one the model can lie with: the
    // number is real, the subject and predicate are invented, and the number gate — which only asks
    // where a number CAME FROM — waves it through. The first fix listed population nouns to block;
    // an adversarial pass shipped every synonym one word off the list (HR, JD, thị trường,
    // headhunter, mô tả công việc — all verbatim, all verified). So there is no noun list: a
    // "%/ratio + word" phrase serves only when FACTS phrase it that way themselves. The noun nobody
    // thought of now costs a templated turn instead of shipping a fabricated statistic.
    const statFacts = buildDiagnosisFacts(
      makeReview({
        top_summary: {
          headline: 'x',
          // TWO actions on purpose: with one, prioritized_actions.length would seed the token "1"
          // into the number gate's allow-list and the "1 tuần / 1 dự án" cases below would pass
          // with or without the ADVICE_NOUN exemption — fixture luck, asserted against below.
          prioritized_actions: [
            'Thêm số liệu vào thành tích (hiện chỉ 9% bullet có số) — vd "giảm 40% thời gian tải".',
            'Bổ sung kỹ năng còn thiếu: Docker.',
          ],
        },
      } as Partial<CvReviewParsedResponse>),
      makeGapReport([
        makeGapItem({ market_demand: 71 }),
        makeGapItem({
          requirement_id: 'jd:hard_skill:redis',
          display_name: 'Redis',
          market_demand: 30,
          severity: 0.4,
        }),
      ]),
    );
    const cited = { cited_gap_id: 'jd:hard_skill:docker' as const };

    it.each([
      ['the original leak', '71% nhà tuyển dụng yêu cầu kỹ năng này.'],
      ['postings + invented predicate', 'Có tới 71% tin tuyển dụng dùng ATS để lọc.'],
      ['a synonym off any list — HR', '71% HR sẽ loại CV của bạn vì thiếu Docker.'],
      ['a synonym off any list — JD', '71% JD yêu cầu Docker và chấm điểm tự động.'],
      ['a synonym off any list — market', '71% thị trường đang yêu cầu Docker.'],
      ['a synonym off any list — headhunter', '71% headhunter sẽ bỏ qua CV của bạn.'],
      [
        'reordered into a relative clause',
        'Docker xuất hiện trong 71% mô tả công việc, và họ dùng ATS để lọc.',
      ],
      ['an English population', '71% job descriptions require Docker and screen with ATS.'],
      ['a connector between % and noun', '71% trong số các nhà tuyển dụng dùng ATS để lọc CV.'],
      [
        'the population moved to the next clause',
        'Trong 71% trường hợp, nhà tuyển dụng sẽ loại CV thiếu Docker.',
      ],
      ['a spelled-out number', 'Bảy mươi mốt phần trăm nhà tuyển dụng yêu cầu Docker.'],
      ['an invented time statistic', '71% thời gian bạn sẽ dùng kỹ năng này.'],
      [
        'an ELIDED population — "sẽ" is not a safe follower',
        '71% sẽ loại CV của bạn ngay vòng đầu.',
      ],
    ])('refuses %s', (_label, message) => {
      expect(groundDiagnosis({ message, ...cited }, statFacts).answer).not.toBe(message);
    });

    // Ratio and scaffold forms carry the same statistic with no "%" token to anchor on. The two that
    // failed before did so only because the fixture happened not to contain 7, 10 or 0.71 — number-
    // gate luck, not protection. These are caught by their FRAME now, whatever digits they carry.
    it.each([
      ['a fraction', '7/10 nhà tuyển dụng yêu cầu kỹ năng này.'],
      ['a fraction over 100', '71/100 nhà tuyển dụng sẽ loại CV của bạn.'],
      ['the "cứ N … có M" frame', 'Cứ 100 tin tuyển dụng thì có 71 tin dùng ATS để lọc.'],
      ['the "tỉ lệ … là N" frame', 'Tỉ lệ nhà tuyển dụng yêu cầu Docker là 0,71.'],
    ])('refuses a rate rephrased as %s', (_label, message) => {
      expect(groundDiagnosis({ message, ...cited }, statFacts).answer).not.toBe(message);
    });

    // Told "never pin 71% to a group", a model complies by DROPPING THE NUMBER and keeping the
    // claim — measured shipping. This arm is still a noun list (unbounded synonyms exist), accepted
    // for the digit-less class only: no fabricated number rides along, and the prompt now forbids
    // the whole subject.
    it.each([
      ['recruiters', 'Phần lớn nhà tuyển dụng yêu cầu kỹ năng này.'],
      ['companies', 'Hầu hết các công ty đều dùng ATS để lọc CV.'],
      ['postings', 'Đa số tin tuyển dụng hiện nay đều yêu cầu Docker.'],
    ])('refuses the digit-less retreat onto %s', (_label, message) => {
      expect(groundDiagnosis({ message, ...cited }, statFacts).answer).not.toBe(message);
    });

    // The attach-to-the-next-word cut fell to a second adversarial pass — every case here SHIPPED
    // VERBATIM against it. The common trick: keep the crowd OUT of the one position the rule
    // inspected. Token licensing is position-blind, so the arrangement stops mattering.
    it.each([
      [
        'the crowd BEFORE a bracket-detached %',
        'Nhà tuyển dụng (71%) đều dùng ATS để lọc CV của bạn.',
      ],
      [
        'the crowd BEFORE a dash-detached %',
        'Nhà tuyển dụng — 71% — sẽ loại CV thiếu Docker của bạn.',
      ],
      [
        'the crowd BEFORE a colon-detached %',
        'Với nhà tuyển dụng, con số là 71%: họ dùng ATS để loại hồ sơ.',
      ],
      ['a pronoun crowd', 'Họ — 71% — sẽ bỏ qua CV thiếu Docker.'],
      ['cross-sentence anaphora', 'Con số là 71%. Nhà tuyển dụng dùng nó để loại bạn.'],
      ['the safe-word "là" as a Trojan', 'Thực tế 71% là nhà tuyển dụng dùng ATS để lọc CV.'],
      ['a comparative bridge', '71% cao hơn vì nhà tuyển dụng đòi hỏi Docker gắt.'],
      [
        'glue "và" into a pronoun claim',
        'Nhu cầu Docker 71% và họ đều dùng ATS để loại hồ sơ thiếu nó.',
      ],
      ['an English bracket-detached crowd', 'Recruiters (71%) screen every CV with ATS.'],
      [
        'a licensed bigram re-aimed at a crowd',
        '40% thời gian nhà tuyển dụng chỉ đọc CV có số liệu.',
      ],
      ['a licensed bigram re-aimed at the market', 'Chỉ 9% bullet trên thị trường đạt chuẩn ATS.'],
      ['the reversed tỉ-lệ frame', '71% là tỷ lệ nhà tuyển dụng yêu cầu Docker.'],
      [
        'a ratio bridged by safe "của"',
        '12/20 của các nhà tuyển dụng sẽ loại CV bạn ngay vòng đầu.',
      ],
      [
        'spelled % with the crowd in front',
        'Nhà tuyển dụng, bảy mươi mốt phần trăm, sẽ loại CV thiếu Docker.',
      ],
    ])('refuses the second-pass evasion: %s', (_label, message) => {
      expect(groundDiagnosis({ message, ...cited }, statFacts).answer).not.toBe(message);
    });

    // What keeps this from strangling the advisor: FACTS-written percentages license their own
    // paraphrases, the field-named market_demand forms stay speakable, and the score-scale register
    // (copulas, comparatives, fact-vs-fact) is exempt because layer 2 owns the crowd cases.
    it.each([
      [
        'the template line itself (field-named %)',
        'Nhu cầu thị trường: 71%. Bước tiếp theo: Học & bổ sung kỹ năng này.',
      ],
      ['the English template line', 'Market demand: 71%. Next action: learn it.'],
      ['a FACTS-verbatim % phrase', 'Thêm số liệu vào thành tích (hiện chỉ 9% bullet có số).'],
      ['another FACTS-verbatim % phrase', 'Ví dụ: "giảm 40% thời gian tải".'],
      [
        'a PARAPHRASE of a FACTS-written % (the prompt forbids parroting)',
        'Hiện chỉ 9% đang có số liệu — mình sẽ bắt đầu từ đó nhé.',
      ],
      ['a connector inside the licensed %', 'Khoảng 9% số bullet của bạn có số liệu.'],
      ['a space before the licensed %', 'Chỉ 9 % bullet có số liệu.'],
      [
        'the two-gap comparison the prompt encourages',
        'Docker có nhu cầu thị trường 71%, Redis 30% — nên học Docker trước.',
      ],
      ['glue after the % ("và")', 'Nhu cầu thị trường Docker là 71% và Redis là 30%.'],
      [
        'a comparative between field-named %s',
        'Nhu cầu thị trường: 71% so với 30% — Docker thắng rõ.',
      ],
      ['a grounded rate said with the tỉ-lệ frame', 'Tỉ lệ bullet có số liệu hiện là 9%.'],
      ['a score ratio with nothing attached', 'skills_relevance của bạn đang ở 12/20.'],
      ['a score ratio read out loud ("điểm")', 'Điểm mục này là 12/20 và còn cải thiện được.'],
      ['the copular score register', 'Điểm action_verbs 14/20 là mức tốt nhất trong 4 mục.'],
      [
        'fact-vs-fact comparison on the scale (promised legal)',
        'Skills_relevance 12/20 thấp hơn hẳn action_verbs 14/20.',
      ],
      [
        'the odds-improvement closer',
        'Sửa mấy lỗi này xong, cơ hội được gọi phỏng vấn của bạn sẽ tốt hơn hẳn.',
      ],
      ['a ONE-week time span', 'Bạn thử dành 1 tuần để thêm số liệu vào các bullet nhé.'],
      ['a ONE-project deliverable', 'Thêm 1 dự án có dùng Docker vào CV nhé.'],
      ['ONE verb and ONE number per bullet', 'Mỗi bullet nên có 1 động từ mạnh và 1 con số.'],
    ])('serves %s', (_label, message) => {
      expect(groundDiagnosis({ message, ...cited }, statFacts).answer).toBe(message);
    });

    // Valued odds stay dead — only the improvement DIRECTION was bought back.
    it.each([
      ['a graded odds estimate', 'Khả năng đậu của bạn là khá cao.'],
      ['an English graded odds estimate', 'Your chances of getting hired are quite high.'],
    ])('still refuses %s', (_label, message) => {
      expect(groundDiagnosis({ message, ...cited }, statFacts, 'en').answer).not.toBe(message);
    });

    it('the fixture cannot make the licensing tests pass by luck', () => {
      const prov = statProvenance(statFacts);
      // 71 is a FIELD percentage (speakable only beside its name), never a WRITTEN one — if FACTS
      // ever grew a literal "71%" string, every refusal above would be testing nothing.
      expect(prov.writtenPcts.has('71')).toBe(false);
      expect(prov.fieldPcts.has('71')).toBe(true);
      // And the served FACTS-verbatim cases must be passing on LICENSING, not on a dead gate.
      expect(prov.writtenPcts.has('9')).toBe(true);
      expect(prov.writtenPcts.has('40')).toBe(true);
      // The "1 tuần / 1 dự án" cases must be passing on the ADVICE_NOUN exemption, not on an
      // array length that happens to seed "1".
      expect(allowedNumberTokens(statFacts).has('1')).toBe(false);
    });
  });

  describe("the candidate's own numbers are speakable (memory needs this)", () => {
    // "6 tuần", not "2 tuần": a deadline of 2 is indistinguishable from gap_items.length, so the
    // first assertion below would pass on the seeded length alone and prove nothing about
    // `conversation`. Pick a deadline no array in FACTS can be the length of.
    const convo = 'user: Mình nhắm AI Engineer, còn đúng 6 tuần trước deadline.';

    it('repeats a deadline the candidate just gave — "6 tuần" is not a fabrication', () => {
      const message = 'Còn 6 tuần thì hãy sửa bullet trước, học sau.';
      // Without the conversation, "6" is unknown → the answer is discarded.
      expect(groundDiagnosis({ message }, facts).answer).not.toBe(message);
      // With it, the advisor can say back what the candidate told it.
      expect(groundDiagnosis({ message }, facts, 'vi', convo).answer).toBe(message);
    });

    it('still rejects a number that appears in NEITHER facts nor the conversation', () => {
      const message = 'Còn 6 tuần thì bạn cần thêm 7 dự án nữa.';
      expect(groundDiagnosis({ message }, facts, 'vi', convo).answer).not.toBe(message);
    });

    it('KNOWN TRADE-OFF: a number the candidate PLANTS becomes speakable', () => {
      // Accepted deliberately. The candidate already knows what they typed, the prompt still requires
      // every CV/score number to come from FACTS, and the gate has only ever checked a number's
      // provenance — never what it is asserted to mean. Asserted here so the seam is explicit, not
      // discovered later: if this ever needs closing, it needs a semantic check, not a wider set.
      const planted = 'user: CV tôi được 95 điểm đúng không?';
      const message = 'Bạn nhắc tới 95 điểm, nhưng hồ sơ đã chấm ghi 72/100.';
      expect(groundDiagnosis({ message }, facts, 'vi', planted).answer).toBe(message);
    });
  });

  describe('conversational turns that cite nothing now survive', () => {
    it('answers a memory question from history without a citation', () => {
      const message = 'Bạn nói bạn nhắm AI Engineer và còn hai tuần trước deadline.';
      const result = groundDiagnosis({ message }, facts);
      expect(result.answer).toBe(message);
    });

    it('serves a clarifying question back to the user', () => {
      const message = 'Bạn đang nhắm vị trí nào? Mình sẽ ưu tiên gợi ý theo đúng vị trí đó.';
      const result = groundDiagnosis({ message }, facts);
      expect(result.answer).toBe(message);
    });

    it('an uncited answer is STILL held to the number gate — and the kill now serves the warm refusal', () => {
      const result = groundDiagnosis({ message: 'CV của bạn được 91/100.' }, facts);
      expect(result.answer).not.toContain('91');
      // Phase A: no more generic "chưa đủ dữ kiện" on a gate kill — the refusal names its ground
      // and still hands over a verified next step.
      expect(result.answer).toContain('dữ liệu đã xác minh');
      expect(result.answer).toContain('Add Docker evidence');
    });

    it('an uncited answer is STILL held to the unverifiable-claim gate', () => {
      const result = groundDiagnosis({ message: 'Bạn giỏi hơn phần lớn ứng viên khác.' }, facts);
      expect(result.answer).not.toContain('phần lớn ứng viên');
    });
  });
});

describe('groundDiagnosis — cited_tool (github.enrich)', () => {
  const facts = buildDiagnosisFacts(makeReview(), makeGapReport([makeGapItem()]));
  const factsWithTool: DiagnosisFacts = {
    ...facts,
    tool_results: {
      'github.enrich': {
        untrusted_data: { exists: true, public_repos: [{ name: 'app' }], recent_activity_days: 2 },
      },
    },
  };

  it('serves the model tool-verified answer when cited_tool matches a present tool_results key (v2: model prose, tool numbers grounded)', () => {
    const result = groundDiagnosis(
      {
        message: 'GitHub của bạn có 1 repo công khai, hoạt động gần nhất 2 ngày trước.',
        cited_dimension: null,
        cited_gap_id: null,
        cited_other_match_index: null,
        cited_tool: 'github.enrich',
      },
      factsWithTool,
      'vi',
    );
    expect(result.answer).toContain('GitHub');
    expect(result.answer).toContain('2'); // recent_activity_days — grounded in tool_results
    expect(result.cited_tool).toBe('github.enrich');
  });

  it('preserves the gap next-step when the model cites both a real gap and a verified tool', () => {
    const result = groundDiagnosis(
      {
        message: 'GitHub có hoạt động thật, nhưng gap Docker vẫn là ưu tiên chính của bạn.',
        cited_gap_id: 'jd:hard_skill:docker',
        cited_tool: 'github.enrich',
      },
      factsWithTool,
      'vi',
    );

    expect(result.cited_gap_id).toBe('jd:hard_skill:docker');
    expect(result.answer).toContain('GitHub');
    expect(result.answer).toContain('Docker');
    expect(result.suggested_next_step).toBe('Học & bổ sung kỹ năng này');
  });

  it('drops cited_tool when tool_results has no such key (model cited a tool that was never actually called) — falls back', () => {
    const result = groundDiagnosis(
      {
        message: 'ok',
        cited_dimension: null,
        cited_gap_id: null,
        cited_other_match_index: null,
        cited_tool: 'github.enrich',
      },
      { ...facts }, // no tool_results at all
      'vi',
    );
    expect(result.answer).not.toContain('GitHub');
  });

  it('exposes cited_tool on the result when it matches a present tool_results key — LIVE BUG: was computed for grounding but never forwarded to the wire', () => {
    const result = groundDiagnosis(
      { message: 'ok', cited_tool: 'github.enrich' },
      factsWithTool,
      'vi',
    );
    expect(result.cited_tool).toBe('github.enrich');
  });

  it('cited_tool is absent from the result when it does not match any tool_results key', () => {
    const result = groundDiagnosis(
      { message: 'ok', cited_tool: 'github.enrich' },
      { ...facts }, // no tool_results at all
      'vi',
    );
    expect(result.cited_tool).toBeUndefined();
  });
});

// ── Phase A: the warm refusal — every gate kill now says WHY, warmly, and still moves them forward ──
describe('buildRefusal via groundDiagnosis — reason-aware refusal copy', () => {
  const facts = buildDiagnosisFacts(makeReview(), makeGapReport([makeGapItem()]));

  const refusalOf = (message: string, language?: string) =>
    groundDiagnosis({ message }, facts, language);

  it('hire-odds bait → the odds refusal, in Vietnamese, with a verified forward step', () => {
    const r = refusalOf('Khả năng đậu của bạn là khá cao.');
    expect(r.answer).toContain('đậu hay không mình không đoán');
    expect(r.answer).toContain('Add Docker evidence');
    expect(r.suggested_next_step).toBe('Add Docker evidence');
  });

  it('peer-comparison bait → the peers refusal', () => {
    const r = refusalOf('Bạn giỏi hơn phần lớn ứng viên khác.');
    expect(r.answer).toContain('so sánh kiểu đó thì mình không làm được thật');
  });

  it('salary bait → the salary refusal, localized to English', () => {
    const r = refusalOf('Your salary should be around 2000 USD.', 'en');
    expect(r.answer).toContain('blind spot');
    expect(r.answer).not.toContain('2000');
  });

  it('invented statistic → the stat refusal', () => {
    const r = refusalOf('Có tới 71% tin tuyển dụng dùng ATS để lọc.');
    expect(r.answer).toContain('nguồn đã xác minh');
    expect(r.answer).not.toContain('71%');
  });

  it('refusal copy itself is REPLAY-SAFE: it passes both gates it explains', () => {
    // Iterate the REAL copy, never a hardcoded mirror — a mirror silently goes stale on the
    // next copy rework (it did on the Wave 1 scene-redirect edit; this file's own rule).
    const prov = statProvenance(facts);
    for (const family of Object.keys(REFUSAL_COPY) as Array<keyof typeof REFUSAL_COPY>) {
      for (const [vi, en] of REFUSAL_COPY[family]) {
        // salary copy legitimately contains the word "lương" — the salary REGEX matches the
        // topic, which is exactly why the model may never write it. Prod never runs the
        // code-authored copy through the gates, so BOTH are asserted here instead: no digits
        // (number gate can never fire on an echo) and no claim-shaped phrasing (a future copy
        // rework must not introduce a sentence unverifiableClaim would flag).
        expect(vi).not.toMatch(/\d/);
        expect(en).not.toMatch(/\d/);
        expect(ungroundedNumbers(vi, allowedNumberTokens(facts))).toEqual([]);
        expect(ungroundedNumbers(en, allowedNumberTokens(facts))).toEqual([]);
        expect(unverifiableClaim(vi, prov)).toBeNull();
        expect(unverifiableClaim(en, prov)).toBeNull();
      }
    }
  });
});

describe('isBenignQuantity — the "số 1" noun-before-number idiom (measured: 2/25 live turns lost)', () => {
  const facts = buildDiagnosisFacts(makeReview(), makeGapReport([makeGapItem()]));
  // Nothing in this fixture licenses a bare "1" (no 1-length arrays beyond what buildDiagnosisFacts
  // seeds — asserted so these tests cannot pass vacuously).

  it('"ưu tiên số 1" and "việc số 1" are formatting, not fabrication', () => {
    for (const message of [
      'Sửa bullet là ưu tiên số 1 của bạn lúc này.',
      'Việc số 1 nên làm: thêm số liệu vào thành tích.',
    ]) {
      expect(groundDiagnosis({ message }, facts).answer).toBe(message);
    }
  });

  it('"số 1" NEVER licenses a scale or a rate: "điểm số 1/20" and "số 1%" still face the gates', () => {
    const scale = groundDiagnosis({ message: 'Mục action_verbs có điểm số 1/20 thôi.' }, facts);
    expect(scale.answer).not.toBe('Mục action_verbs có điểm số 1/20 thôi.');
    const rate = groundDiagnosis({ message: 'Chỉ số 1% hồ sơ được chọn.' }, facts);
    expect(rate.answer).not.toBe('Chỉ số 1% hồ sơ được chọn.');
  });
});

describe('isBenignQuantity — advice-register buys measured on the 07-16 live run', () => {
  const facts = buildDiagnosisFacts(makeReview(), makeGapReport([makeGapItem()]));

  it('"1 kỹ năng" and a SMALL range (≤3) over an advice noun serve verbatim', () => {
    for (const message of [
      'Bạn nên chọn đúng 1 kỹ năng để bổ sung trước.',
      'Sửa 1–2 bullet đầu tiên là đủ tạo đà.',
      'Viết lại 1-2 câu mở đầu cho mạnh hơn.',
      'Dành 2–3 buổi để ôn Statistics.',
    ]) {
      expect(groundDiagnosis({ message }, facts).answer).toBe(message);
    }
  });

  it('a range over a NON-advice noun still faces the gate ("6–7 gap" is a count of the record)', () => {
    for (const message of ['Bạn có 6–7 gap cần sửa.', 'CV bạn tầm 6–7 điểm là cùng.']) {
      expect(groundDiagnosis({ message }, facts).answer).not.toBe(message);
    }
  });

  it('a range ABOVE the ≤3 cap faces the gate even over an advice noun (fabricated counts rode it)', () => {
    // Adversarial review 2026-07-17: uncapped, "còn thiếu 7-8 kỹ năng" / "có 5-6 bullet chưa có
    // số liệu" — counts of the record — shipped on this rail. "6–7 buổi" time-budget advice is
    // the accepted quality cost: a time-noun carve-out would re-open "7-8 tháng kinh nghiệm".
    for (const message of [
      'Dành 6–7 buổi để ôn Statistics.',
      'Bạn còn thiếu 7-8 kỹ năng quan trọng trong CV.',
    ]) {
      expect(groundDiagnosis({ message }, facts).answer).not.toBe(message);
    }
  });
});

describe('answer_kind — the pose signal for the FE mascot (Wave 1)', () => {
  const facts = buildDiagnosisFacts(makeReview(), makeGapReport([makeGapItem()]));

  it('served prose → grounded; gate kill → refusal; deterministic fallback → grounded', () => {
    const served = groundDiagnosis(
      { message: 'Bạn nên sửa bullet đầu tiên cho có số liệu.' },
      facts,
    );
    expect(served.answer_kind).toBe('grounded');
    const killed = groundDiagnosis({ message: 'Điểm ATS của bạn là 98.' }, facts);
    expect(killed.answer_kind).toBe('refusal');
    // The fallback is FACTS-built prose — the dolphin has nothing to apologize for.
    expect(groundDiagnosis(null, facts).answer_kind).toBe('grounded');
    expect(groundDiagnosis({ message: '   ' }, facts).answer_kind).toBe('grounded');
  });
});

describe('grounded_facts — provenance is exact by construction (Wave 2)', () => {
  const facts = buildDiagnosisFacts(makeReview(), makeGapReport([makeGapItem()]));

  it('a served answer lists exactly the citations the gate resolved', () => {
    const result = groundDiagnosis(
      {
        message: 'Docker đang là gap ưu tiên của bạn.',
        cited_dimension: 'action_verbs',
        cited_gap_id: 'jd:hard_skill:docker',
      },
      facts,
    );
    expect(result.answer_kind).toBe('grounded');
    expect(result.grounded_facts).toEqual([
      { kind: 'dimension', id: 'action_verbs', label: 'action_verbs' },
      { kind: 'gap', id: 'jd:hard_skill:docker', label: 'Docker' },
    ]);
  });

  it('other_match and tool citations become facts (1-based index / tool name as id)', () => {
    const factsWith: DiagnosisFacts = {
      ...buildDiagnosisFacts(makeReview(), makeGapReport([makeGapItem()]), null, [
        { jd_title: 'Frontend Developer', overall_score: 72, top_gaps: ['React'] },
        { jd_title: 'Backend Developer', overall_score: 55, top_gaps: ['Docker'] },
      ]),
      tool_results: {
        'github.enrich': { untrusted_data: { exists: true, public_repos: [] } },
      },
    };
    const result = groundDiagnosis(
      {
        message: 'JD Backend Developer đang ở 55, GitHub của bạn có hoạt động thật.',
        cited_other_match_index: 2,
        cited_tool: 'github.enrich',
      },
      factsWith,
    );
    expect(result.grounded_facts).toEqual([
      { kind: 'other_match', id: '2', label: 'Backend Developer' },
      { kind: 'tool', id: 'github.enrich', label: 'github.enrich' },
    ]);
  });

  it('an INVALID citation produces no fact (stripped citations stay stripped)', () => {
    const result = groundDiagnosis(
      {
        message: 'Bạn nên vá Docker trước.',
        cited_dimension: 'not_a_dimension',
        cited_gap_id: 'jd:soft_skill:nope',
      },
      facts,
    );
    expect(result.answer_kind).toBe('grounded');
    expect(result.grounded_facts).toEqual([]);
  });

  it('a refusal claims nothing → empty grounded_facts, while citations survive as scroll targets', () => {
    const result = groundDiagnosis(
      { message: 'Điểm ATS của bạn là 98.', cited_gap_id: 'jd:hard_skill:docker' },
      facts,
    );
    expect(result.answer_kind).toBe('refusal');
    expect(result.cited_gap_id).toBe('jd:hard_skill:docker');
    expect(result.grounded_facts).toEqual([]);
  });

  it('the deterministic fallback carries empty grounded_facts', () => {
    expect(groundDiagnosis(null, facts).grounded_facts).toEqual([]);
  });

  describe("kind 'conversation' — candidate-licensed numbers are labeled, not laundered", () => {
    it('a number licensed ONLY by candidate speech becomes a conversation fact', () => {
      const result = groundDiagnosis(
        { message: 'Với 2 tuần còn lại, bạn nên vá Docker trước.' },
        facts,
        'vi',
        'mình còn đúng 2 tuần trước deadline',
      );
      expect(result.answer_kind).toBe('grounded');
      expect(result.grounded_facts).toEqual([{ kind: 'conversation', id: '2', label: '2' }]);
    });

    it('a token FACTS already backs is NOT labeled conversation, even if the candidate said it too', () => {
      // 14 = action_verbs score20 — FACTS provenance wins over the echo.
      const result = groundDiagnosis(
        { message: 'Điểm action_verbs của bạn là 14/20.', cited_dimension: 'action_verbs' },
        facts,
        'vi',
        'điểm 14 của mình thấp không?',
      );
      expect(result.grounded_facts).toEqual([
        { kind: 'dimension', id: 'action_verbs', label: 'action_verbs' },
      ]);
    });

    it('no candidate speech → no conversation facts', () => {
      const result = groundDiagnosis({ message: 'Bạn nên vá Docker trước.' }, facts, 'vi');
      expect(result.grounded_facts).toEqual([]);
    });

    it('a token repeated in the answer yields ONE fact', () => {
      const result = groundDiagnosis(
        { message: 'Còn 2 tuần — với 2 tuần đó, tập trung Docker.' },
        facts,
        'vi',
        'mình còn 2 tuần',
      );
      expect(result.grounded_facts.filter((f) => f.kind === 'conversation')).toHaveLength(1);
    });

    it('advice-register exempt numbers (1-2 bullet) are served but NEVER advertised as provenance', () => {
      const result = groundDiagnosis(
        { message: 'Thêm 1-2 bullet định lượng vào phần kinh nghiệm nhé.' },
        facts,
        'vi',
      );
      expect(result.answer_kind).toBe('grounded');
      expect(result.grounded_facts).toEqual([]);
    });
  });
});

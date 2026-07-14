import { CvReviewParsedResponse } from '../cv-review/dto/cv-review-response.dto';
import { SkillBridgeGapReport } from '../gap-report/gap-report.service';
import { GapItem } from '../gap-engine/gap-item';
import { ProgressReport } from '../gap-report/gap-progress';
import {
  buildDiagnosisFacts,
  DIAGNOSIS_DIMENSION_KEYS,
  DiagnosisFacts,
  groundDiagnosis,
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

  it('keeps valid citations but renders the visible answer from facts, not raw LLM prose', () => {
    const result = groundDiagnosis(
      {
        message: 'Your ATS is 98 and you should learn Kubernetes immediately.',
        cited_dimension: 'skills_relevance',
        cited_gap_id: 'jd:hard_skill:docker',
        suggested_next_step: 'Buy this Kubernetes course.',
      },
      facts,
    );
    expect(result.answer).toContain('skills_relevance');
    expect(result.answer).toContain('12/20');
    expect(result.answer).toContain('Docker');
    expect(result.answer).not.toContain('98');
    expect(result.answer).not.toContain('Kubernetes');
    expect(result.cited_dimension).toBe('skills_relevance');
    expect(result.cited_gap_id).toBe('jd:hard_skill:docker');
    expect(result.suggested_next_step).toBe('Học & bổ sung kỹ năng này');
  });

  it('falls back when the model does not provide any valid citation', () => {
    const result = groundDiagnosis({ message: 'ok' }, facts);
    expect(result.answer).toContain('Add Docker evidence');
    expect(result.answer).not.toBe('ok');
    expect(result.cited_dimension).toBeUndefined();
    expect(result.cited_gap_id).toBeUndefined();
  });

  it('DROPS cited_dimension that is not a real dimension key', () => {
    const result = groundDiagnosis({ message: 'ok', cited_dimension: 'charisma' }, facts);
    expect(result.answer).toContain('Add Docker evidence');
    expect(result.cited_dimension).toBeUndefined();
  });

  it('DROPS cited_gap_id that is not in facts.gap_items requirement_ids', () => {
    const result = groundDiagnosis(
      { message: 'ok', cited_gap_id: 'jd:hard_skill:kubernetes' },
      facts,
    );
    expect(result.answer).toContain('Add Docker evidence');
    expect(result.cited_gap_id).toBeUndefined();
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

  it('renders a grounded other-match comparison when the model cites a listed match index', () => {
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

    expect(result.answer).toContain('Frontend Developer');
    expect(result.answer).toContain('72');
    expect(result.answer).toContain('React');
    expect(result.answer).toContain('TypeScript');
    expect(result.answer).not.toContain('2000');
    expect(result.suggested_next_step).toBeNull();
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

  it('honest fallback ADMITS it cannot answer instead of answering a different question', () => {
    const vi = groundDiagnosis({ message: 'ok' }, facts);
    expect(vi.answer).toContain('chưa đủ dữ kiện đã xác minh');
    expect(vi.answer).toContain('Add Docker evidence'); // still serves the verified priorities

    const en = groundDiagnosis({ message: 'ok' }, facts, 'en');
    expect(en.answer).toContain("can't answer that confidently");
    expect(en.answer).toContain('Add Docker evidence');
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

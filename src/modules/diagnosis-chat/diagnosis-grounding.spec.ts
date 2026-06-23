import { CvReviewParsedResponse } from '../cv-review/dto/cv-review-response.dto';
import { SkillBridgeGapReport } from '../gap-report/gap-report.service';
import { GapItem } from '../gap-engine/gap-item';
import {
  buildDiagnosisFacts,
  DIAGNOSIS_DIMENSION_KEYS,
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

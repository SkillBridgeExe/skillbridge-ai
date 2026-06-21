import {
  ANSWER_INSIGHT_SCHEMA,
  AnswerInsight,
  groundAnswerInsight,
} from '../../../src/modules/interview/answer-insight';
import {
  analyzeAnswerSignals,
  AnswerSignals,
} from '../../../src/modules/interview/answer-analyzer';

/** a baseline AnswerSignals with a concrete example, ideal length, no rambling risk. */
function concreteSignals(over: Partial<AnswerSignals> = {}): AnswerSignals {
  const base = analyzeAnswerSignals({
    answer:
      'When the checkout page was slow, I implemented a Redis cache and reduced p99 latency by 30%.',
    jd_terms: ['Redis'],
    language: 'en',
  });
  return { ...base, ...over };
}

/** a baseline AnswerSignals with NO concrete example, not rambling. */
function thinSignals(over: Partial<AnswerSignals> = {}): AnswerSignals {
  const base = analyzeAnswerSignals({
    answer: 'I am not really sure about that one to be honest.',
    language: 'en',
  });
  return { ...base, ...over };
}

describe('groundAnswerInsight — valid parse passthrough', () => {
  it('passes through valid enums + clamped relevance and derives evidence_quality from L1', () => {
    const signals = concreteSignals();
    expect(signals.has_concrete_example).toBe(true);
    const out = groundAnswerInsight(
      {
        talking_point: 'project',
        relevance: 88,
        clarity: 'clear',
        off_topic: false,
        confidence_tone: 'calibrated',
        note: 'Strong, evidence-backed answer.',
        // model MUST NOT be trusted for evidence_quality — even if present it is ignored.
        evidence_quality: 'thin',
      },
      signals,
    );
    expect(out.talking_point).toBe('project');
    expect(out.relevance).toBe(88);
    expect(out.clarity).toBe('clear');
    expect(out.off_topic).toBe(false);
    expect(out.confidence_tone).toBe('calibrated');
    expect(out.note).toBe('Strong, evidence-backed answer.');
    // concrete example present → strong, regardless of the model's bogus 'thin'.
    expect(out.evidence_quality).toBe('strong');
  });
});

describe('groundAnswerInsight — enum validation + fallback defaults', () => {
  it('falls back to defaults for invalid/missing enums', () => {
    const out = groundAnswerInsight(
      {
        talking_point: 'banana',
        relevance: 50,
        clarity: 'sparkling',
        off_topic: false,
        confidence_tone: 'megaconfident',
        note: 'x',
      },
      thinSignals(),
    );
    expect(out.talking_point).toBe('experience');
    expect(out.clarity).toBe('adequate');
    expect(out.confidence_tone).toBe('calibrated');
  });

  it('falls back when enum keys are entirely missing', () => {
    const out = groundAnswerInsight({ relevance: 60 }, thinSignals());
    expect(out.talking_point).toBe('experience');
    expect(out.clarity).toBe('adequate');
    expect(out.confidence_tone).toBe('calibrated');
  });
});

describe('groundAnswerInsight — relevance clamping', () => {
  it('clamps relevance above 100 down to 100', () => {
    expect(groundAnswerInsight({ relevance: 150 }, thinSignals()).relevance).toBe(100);
  });

  it('clamps relevance below 0 up to 0', () => {
    expect(groundAnswerInsight({ relevance: -20 }, thinSignals()).relevance).toBe(0);
  });

  it('defaults a non-number relevance to 50', () => {
    expect(groundAnswerInsight({ relevance: 'x' }, thinSignals()).relevance).toBe(50);
    expect(groundAnswerInsight({}, thinSignals()).relevance).toBe(50);
    expect(groundAnswerInsight({ relevance: Number.NaN }, thinSignals()).relevance).toBe(50);
  });
});

describe('groundAnswerInsight — off_topic safety net', () => {
  it('raises off_topic to true when L1 rambling_risk and relevance < 40', () => {
    const signals = thinSignals({
      flags: { is_too_short: false, no_concrete_example: true, rambling_risk: true },
    });
    const out = groundAnswerInsight(
      { off_topic: false, relevance: 20, confidence_tone: 'calibrated' },
      signals,
    );
    expect(out.off_topic).toBe(true);
  });

  it('does not raise off_topic when relevance >= 40 even if rambling_risk', () => {
    const signals = thinSignals({
      flags: { is_too_short: false, no_concrete_example: true, rambling_risk: true },
    });
    const out = groundAnswerInsight({ off_topic: false, relevance: 55 }, signals);
    expect(out.off_topic).toBe(false);
  });

  it('coerces a truthy model off_topic to boolean true', () => {
    const out = groundAnswerInsight({ off_topic: true, relevance: 80 }, thinSignals());
    expect(out.off_topic).toBe(true);
  });
});

describe('groundAnswerInsight — evidence_quality DERIVED from L1', () => {
  it('concrete example present → strong (ignores model evidence_quality)', () => {
    const out = groundAnswerInsight(
      { confidence_tone: 'over', evidence_quality: 'overclaimed' },
      concreteSignals(),
    );
    expect(out.evidence_quality).toBe('strong');
  });

  it('no concrete + confidence over → overclaimed', () => {
    const out = groundAnswerInsight(
      { confidence_tone: 'over', evidence_quality: 'strong' },
      thinSignals(),
    );
    expect(out.evidence_quality).toBe('overclaimed');
  });

  it('no concrete + not over → thin', () => {
    const out = groundAnswerInsight(
      { confidence_tone: 'calibrated', evidence_quality: 'strong' },
      thinSignals(),
    );
    expect(out.evidence_quality).toBe('thin');
  });
});

describe('groundAnswerInsight — note hardening', () => {
  it('trims, caps at 200 chars, and strips raw URLs', () => {
    const out = groundAnswerInsight(
      { note: '  See https://evil.example.com/leak and www.foo.io for more.  ' },
      thinSignals(),
    );
    expect(out.note.startsWith('See ')).toBe(true);
    expect(out.note).not.toContain('https://');
    expect(out.note).not.toContain('www.foo.io');
    expect(out.note.length).toBeLessThanOrEqual(200);
  });

  it('caps a very long note to 200 chars', () => {
    const long = 'a'.repeat(500);
    expect(groundAnswerInsight({ note: long }, thinSignals()).note.length).toBe(200);
  });

  it('defaults a non-string note to empty string', () => {
    expect(groundAnswerInsight({ note: 123 }, thinSignals()).note).toBe('');
  });
});

describe('groundAnswerInsight — null parsed (LLM failed) → safe fallback', () => {
  it('returns all defaults with evidence_quality still derived from signals', () => {
    const out: AnswerInsight = groundAnswerInsight(null, concreteSignals());
    expect(out.talking_point).toBe('experience');
    expect(out.relevance).toBe(50);
    expect(out.clarity).toBe('adequate');
    expect(out.off_topic).toBe(false);
    expect(out.confidence_tone).toBe('calibrated');
    expect(out.evidence_quality).toBe('strong'); // concrete signals → strong even on fallback
    expect(out.note).toBe('');
  });

  it('thin signals on fallback derive thin', () => {
    expect(groundAnswerInsight(null, thinSignals()).evidence_quality).toBe('thin');
  });
});

describe('ANSWER_INSIGHT_SCHEMA', () => {
  it('is a strict object schema with the 6 MODEL fields and NO evidence_quality', () => {
    expect(ANSWER_INSIGHT_SCHEMA.type).toBe('object');
    expect(ANSWER_INSIGHT_SCHEMA.additionalProperties).toBe(false);
    const props = ANSWER_INSIGHT_SCHEMA.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(
      ['clarity', 'confidence_tone', 'note', 'off_topic', 'relevance', 'talking_point'].sort(),
    );
    expect(props.evidence_quality).toBeUndefined();
  });
});

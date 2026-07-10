import { buildCvAssistantExplanation } from './cv-assistant-explain';
import { analyzeBulletGaps, analyzeSummaryGaps } from './cv-assistant';

/**
 * P3-3 contract: the explanation is read-only (type:'explanation', no patch field at all),
 * bilingual, and cites ONLY signals the deterministic analysis actually detected.
 */
describe('buildCvAssistantExplanation', () => {
  const ctx = (over: Partial<Parameters<typeof buildCvAssistantExplanation>[0]>) => ({
    page: 'cv_builder' as const,
    section: 'experience' as const,
    current_value: 'Worked on the project.',
    locale: 'en' as const,
    ...over,
  });

  it('EN weak bullet: cites exactly the detected gaps, in message and citedSignals', () => {
    const res = buildCvAssistantExplanation(ctx({}));
    expect(res).toEqual({
      type: 'explanation',
      message: expect.stringContaining('why this reads weak'),
      citedSignals: ['missing_action', 'missing_tech', 'missing_result'],
    });
    expect(res).not.toHaveProperty('field_patch');
  });

  it('VI weak summary: summary gaps map to role/tech/evidence signals, message in Vietnamese', () => {
    const res = buildCvAssistantExplanation(
      ctx({ section: 'summary', current_value: 'Chăm chỉ và ham học hỏi.', locale: 'vi' }),
    );
    expect(res).toEqual({
      type: 'explanation',
      message: expect.stringContaining('chưa thuyết phục'),
      citedSignals: ['missing_role', 'missing_tech', 'weak_evidence'],
    });
  });

  it('a strong bullet gets an honest "nothing to fix" with zero cited signals', () => {
    const strong = 'Optimized PostgreSQL queries and reduced latency by 30%.';
    expect(analyzeBulletGaps(strong, 'en')).toEqual([]);
    expect(buildCvAssistantExplanation(ctx({ current_value: strong }))).toEqual({
      type: 'explanation',
      message: expect.stringContaining('Nothing to fix'),
      citedSignals: [],
    });
  });

  it('cites ONLY what the deterministic analysis returns (subset lock, per signal)', () => {
    // Has action + tech, missing only a result → exactly one signal.
    const partial = 'Built the checkout flow with React.';
    expect(analyzeBulletGaps(partial, 'en')).toEqual(['result']);
    expect(buildCvAssistantExplanation(ctx({ current_value: partial }))?.citedSignals).toEqual([
      'missing_result',
    ]);

    const partialSummary = 'Backend developer with 2 years experience.';
    expect(analyzeSummaryGaps(partialSummary, 'en')).toEqual(['strength']);
    expect(
      buildCvAssistantExplanation(ctx({ section: 'summary', current_value: partialSummary }))
        ?.citedSignals,
    ).toEqual(['missing_tech']);
  });

  it('returns null for empty values and non-explainable sections', () => {
    expect(buildCvAssistantExplanation(ctx({ current_value: '   ' }))).toBeNull();
    expect(buildCvAssistantExplanation(ctx({ section: 'skills' as never }))).toBeNull();
  });
});

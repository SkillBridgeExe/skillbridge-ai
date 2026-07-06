import { simulateActionImpact } from '../../../src/modules/gap-report/impact-simulator';
import { computeSeverity, GapItem } from '../../../src/modules/gap-engine/gap-item';

/**
 * Wave-8 × Wave-4 seam (found by the 2026-07-06 logic stress matrix): a gap item whose severity
 * was RAISED by a real interview signal must have its `severity_drop` computed with the SAME
 * signal on the after-fix side — the signal is not stored on GapItem (mirror of the ranking
 * re-supply in gap-item.ts), so the simulator must be handed it explicitly. Without it the
 * after-fix severity is computed un-raised and the promised drop is inflated: add_evidence
 * cannot un-happen a bad interview.
 */
describe('simulateActionImpact × interview signal', () => {
  const ARRAYS = {
    matched_skills: [],
    partial_skills: [],
    missing_skills: [],
  } as never;

  const baseFields = {
    importance: 'REQUIRED',
    gap_levels: 2,
    evidence_risk: 'unproven',
    cv_status: 'overclaimed',
    market_demand: null,
  } as const;

  const SIGNAL = 0.95;

  const gapItem = (severity: number): GapItem =>
    ({
      requirement_id: 'r1',
      source: 'jd',
      type: 'hard_skill',
      canonical_name: 'react',
      display_name: 'React',
      satisfied_by: null,
      evidence_refs: [],
      fixability: 'add_evidence',
      confidence: 'high',
      recommended_next_action: '',
      cv_level: 4,
      required_level: 3,
      severity,
      ...baseFields,
    }) as never;

  const action = {
    action_type: 'add_evidence',
    skill_canonical: 'react',
    action_id: 'add_evidence:react',
  } as never;

  it('signal-raised item: both sides of severity_drop carry the signal (no inflated promise)', () => {
    // The severity buildGapItems would persist for this item WITH the interview signal:
    const raisedSeverity = computeSeverity({ ...baseFields, interview_risk_signal: SIGNAL });
    // Ground truth: the after-fix severity ALSO carries the signal (evidence_risk drops one notch).
    const droppedWithSignal = computeSeverity({
      ...baseFields,
      evidence_risk: 'listed_only',
      interview_risk_signal: SIGNAL,
    });
    const expectedDrop = Math.round((raisedSeverity - droppedWithSignal) * 1000) / 1000;

    const impact = simulateActionImpact(ARRAYS, gapItem(raisedSeverity), action, {
      interviewRiskSignal: SIGNAL,
    });

    expect(impact.score_min).toBe(0); // honest-zero unchanged
    expect(impact.score_max).toBe(0);
    expect(impact.severity_drop).toBe(expectedDrop);
    // Sanity: the inflated (un-raised after side) figure would be strictly larger.
    const droppedUnraised = computeSeverity({ ...baseFields, evidence_risk: 'listed_only' });
    expect(raisedSeverity - droppedUnraised).toBeGreaterThan(expectedDrop + 1e-6);
  });

  it('no signal: behavior byte-identical to before (opts absent)', () => {
    const severity = computeSeverity(baseFields);
    const impact = simulateActionImpact(ARRAYS, gapItem(severity), action);
    const dropped = computeSeverity({ ...baseFields, evidence_risk: 'listed_only' });
    expect(impact.severity_drop).toBe(Math.round((severity - dropped) * 1000) / 1000);
  });

  it('severity_drop is never negative on pipeline-consistent items', () => {
    const severity = computeSeverity({ ...baseFields, interview_risk_signal: SIGNAL });
    const impact = simulateActionImpact(ARRAYS, gapItem(severity), action, {
      interviewRiskSignal: SIGNAL,
    });
    expect(impact.severity_drop).toBeGreaterThanOrEqual(0);
  });
});

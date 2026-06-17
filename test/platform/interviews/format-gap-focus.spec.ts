import { formatGapFocusForPrompt } from '../../../src/platform/interviews/interviews.service';
import { InterviewFocusArea } from '../../../src/modules/interview/interview-planner';

const fa = (over: Partial<InterviewFocusArea>): InterviewFocusArea => ({
  skill_canonical: 'react',
  display_name: 'React',
  focus_type: 'gap_probe',
  reason: 'missing required skill',
  difficulty: 'applied',
  template_question: 'Tell me about React',
  ...over,
});

describe('formatGapFocusForPrompt', () => {
  it('returns empty string when there are no focus areas (caller falls back to raw weaknesses)', () => {
    expect(formatGapFocusForPrompt([])).toBe('');
  });

  it('lists focus areas in order with focus_type + display_name + reason', () => {
    const out = formatGapFocusForPrompt([
      fa({ display_name: 'React', focus_type: 'gap_probe', reason: 'missing' }),
      fa({ display_name: 'SQL', focus_type: 'depth_probe', reason: 'partial depth' }),
    ]);
    expect(out).toContain('Priority focus areas');
    expect(out).toMatch(/1\. \[gap_probe\] React — missing/);
    expect(out).toMatch(/2\. \[depth_probe\] SQL — partial depth/);
    // severity order is preserved (the plan is already ranked upstream).
    expect(out.indexOf('React')).toBeLessThan(out.indexOf('SQL'));
  });
});

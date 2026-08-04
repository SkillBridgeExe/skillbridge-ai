import { CvReviewParsedResponse } from '../../modules/cv-review/dto/cv-review-response.dto';
import { diagnosisPremiumView } from './diagnosis-premium-access';

const review = {
  rationale: {
    action_verbs: 'Paid action rationale',
    skills_relevance: 'Paid skill rationale',
    experience: 'Paid experience rationale',
    education: 'Paid education rationale',
  },
  top_summary: {
    headline: 'Paid headline with top fix',
    prioritized_actions: ['Add Docker evidence'],
  },
  bullet_feedback: [
    {
      text: 'Built an API',
      section: 'experience',
      verbFirst: true,
      quantified: false,
      weakOpener: false,
      firstPerson: false,
      fillerCount: 0,
      tips: ['Add a measurable result'],
    },
  ],
  buzzwords_detected: ['hardworking'],
  skills_relevance_breakdown: {
    matched: [],
    partial: [],
    missing: [{ name: 'Docker', importance: 'REQUIRED', required_level: 2 }],
  },
  sections: [
    {
      name: 'Experience clarity',
      score: 17,
      issues: [
        { severity: 'warning', text: 'Paid issue one', hint: 'Paid suggestion one' },
        { severity: 'warning', text: 'Paid issue two', hint: 'Paid suggestion two' },
      ],
    },
    {
      name: 'Education',
      score: 10,
      issues: [{ severity: 'info', text: 'Paid education issue' }],
    },
  ],
} as unknown as CvReviewParsedResponse;

describe('diagnosisPremiumView', () => {
  it('removes paid issue details for a locked response without mutating the persisted review', () => {
    const result = diagnosisPremiumView(review, false);

    expect(result.premiumDetails).toEqual({ unlocked: false, lockedIssueCount: 3 });
    expect(result.review.sections.map((section) => section.issues)).toEqual([
      [
        { severity: 'warning', text: '' },
        { severity: 'warning', text: '' },
      ],
      [{ severity: 'info', text: '' }],
    ]);
    expect(result.review.rationale).toEqual({
      action_verbs: '',
      skills_relevance: '',
      experience: '',
      education: '',
    });
    expect(result.review.top_summary).toEqual({ headline: '', prioritized_actions: [] });
    expect(result.review.bullet_feedback).toEqual([]);
    expect(result.review.buzzwords_detected).toEqual([]);
    expect(result.review.skills_relevance_breakdown).toBeNull();
    expect(review.sections[0].issues[0].text).toBe('Paid issue one');
    expect(review.top_summary.prioritized_actions).toEqual(['Add Docker evidence']);
  });

  it('returns the complete review for Premium access', () => {
    const result = diagnosisPremiumView(review, true);

    expect(result.premiumDetails).toEqual({ unlocked: true, lockedIssueCount: 0 });
    expect(result.review).toBe(review);
  });
});

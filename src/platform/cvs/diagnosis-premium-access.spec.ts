import { CvReviewParsedResponse } from '../../modules/cv-review/dto/cv-review-response.dto';
import { diagnosisPremiumView } from './diagnosis-premium-access';

const review = {
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
} as CvReviewParsedResponse;

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
    expect(review.sections[0].issues[0].text).toBe('Paid issue one');
  });

  it('returns the complete review for Premium access', () => {
    const result = diagnosisPremiumView(review, true);

    expect(result.premiumDetails).toEqual({ unlocked: true, lockedIssueCount: 0 });
    expect(result.review).toBe(review);
  });
});

import { CvReviewParsedResponse } from '../../modules/cv-review/dto/cv-review-response.dto';

export interface DiagnosisPremiumDetails {
  unlocked: boolean;
  lockedIssueCount: number;
}

export interface DiagnosisPremiumView {
  review: CvReviewParsedResponse;
  premiumDetails: DiagnosisPremiumDetails;
}

/**
 * Redacts paid audit details only at the response boundary. The persisted ai_result stays complete,
 * so upgrading to Premium reveals the original analysis without another model call.
 */
export function diagnosisPremiumView(
  review: CvReviewParsedResponse,
  unlocked: boolean,
): DiagnosisPremiumView {
  const lockedIssueCount = review.sections.reduce(
    (total, section) => total + section.issues.length,
    0,
  );

  if (unlocked) {
    return {
      review,
      premiumDetails: { unlocked: true, lockedIssueCount: 0 },
    };
  }

  return {
    review: {
      ...review,
      sections: review.sections.map((section) => ({
        ...section,
        // Preserve the structural count/location so the FE can render the correct locked cards.
        // Paid text and hints never cross the API boundary.
        issues: section.issues.map((issue) => ({
          severity: issue.severity,
          text: '',
        })),
      })),
    },
    premiumDetails: { unlocked: false, lockedIssueCount },
  };
}

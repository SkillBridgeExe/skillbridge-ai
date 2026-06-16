import { IsIn, IsOptional } from 'class-validator';

/**
 * Body for POST /api/cv-matches/:matchId/interview-plan.
 *
 * Carries NO skills/topics: the interview focus areas are derived server-side from the persisted
 * GapReport (buildInterviewPlanFromGapItems, skill-type gaps only). Only the language knob is accepted.
 */
export class InterviewPlanFromMatchDto {
  @IsOptional()
  @IsIn(['vi', 'en'])
  lang?: 'vi' | 'en';
}

import { BadRequestException, Injectable } from '@nestjs/common';
import { buildUnifiedPlan, UnifiedDevelopmentPlan } from '../../modules/gap-report/unified-plan';
import { InterviewGapItem, InterviewGapReport } from '../../modules/interview/interview-gap';
import { InterviewGapReportService } from '../interviews/interview-gap-report.service';
import { CvMatchesService } from './cv-matches.service';

@Injectable()
export class UnifiedPlanService {
  constructor(
    private readonly cvMatches: CvMatchesService,
    private readonly interviewGap: InterviewGapReportService,
  ) {}

  async get(userId: string, matchId: string, sessionId?: string): Promise<UnifiedDevelopmentPlan> {
    const report = await this.cvMatches.getGapReport(userId, matchId);
    let interviewItems: InterviewGapItem[] = [];
    let resolvedSessionId: string | null = null;
    let interviewReport: InterviewGapReport | null = null;

    if (sessionId) {
      interviewReport = await this.interviewGap.get(userId, sessionId);
      if (interviewReport.match_id !== matchId) {
        throw new BadRequestException('Interview session does not belong to this CV match');
      }
    } else {
      interviewReport = await this.interviewGap.getLatestForMatch(userId, matchId);
    }

    if (interviewReport) {
      interviewItems = interviewReport.gap_items;
      resolvedSessionId = interviewReport.session_id;
    }

    return buildUnifiedPlan({
      matchId,
      sessionId: resolvedSessionId,
      gapItems: report.gap_items,
      interviewItems,
    });
  }
}

import { Injectable, NotFoundException } from '@nestjs/common';
import { CvJdMatchParsedResponse } from '../../cv-jd-match/dto/cv-jd-match-response.dto';
import { SkillDemandService } from './skill-demand.service';
import {
  buildJdMarketPosition,
  ImpliedSkill,
  JdMarketSkill,
  TRENDS_LIMIT,
} from './jd-market-position';

export type JdMarketPositionDto =
  | {
      available: true;
      role_code: string;
      period: string;
      total_active_jobs: number;
      jd_skills: JdMarketSkill[];
      implied: ImpliedSkill[];
    }
  | { available: false; reason: 'NO_ROLE' | 'NO_SNAPSHOT' };

/**
 * JD-vs-market positioning over the persisted match. Deterministic (no LLM, no tracing).
 * NEVER throws for the two expected conditions — returns { available:false, reason } so the
 * platform wrapper (Tuấn's tailor route) can embed it without try/catch. Exported from
 * JobsModule; intended to be composed into GET /api/cv-matches/:matchId/tailor-checklist.
 */
@Injectable()
export class JdMarketPositionService {
  constructor(private readonly skillDemand: SkillDemandService) {}

  async build(input: {
    match: CvJdMatchParsedResponse;
    lang?: 'vi' | 'en';
  }): Promise<JdMarketPositionDto> {
    const role = input.match.target_role;
    if (!role) return { available: false, reason: 'NO_ROLE' };
    let trends;
    try {
      trends = await this.skillDemand.getTrends(role, TRENDS_LIMIT);
    } catch (err) {
      if (err instanceof NotFoundException) return { available: false, reason: 'NO_SNAPSHOT' };
      throw err;
    }
    const { jd_skills, implied } = buildJdMarketPosition(input.match, trends, input.lang ?? 'vi');
    return {
      available: true,
      role_code: trends.role_code,
      period: trends.period,
      total_active_jobs: trends.total_active_jobs,
      jd_skills,
      implied,
    };
  }
}

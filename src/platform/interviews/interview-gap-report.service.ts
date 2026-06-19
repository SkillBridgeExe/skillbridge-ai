import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { AiResultEntity } from '../../database/entities/ai-result.entity';
import { InterviewSessionEntity } from '../../database/entities/interview-session.entity';
import {
  coerceInterviewGapItems,
  groundInterviewGaps,
  InterviewGapReport,
} from '../../modules/interview/interview-gap';
import { CvMatchesService } from '../cv-matches/cv-matches.service';

@Injectable()
export class InterviewGapReportService {
  constructor(
    @InjectRepository(InterviewSessionEntity)
    private readonly sessions: Repository<InterviewSessionEntity>,
    @InjectRepository(AiResultEntity)
    private readonly aiResults: Repository<AiResultEntity>,
    private readonly cvMatches?: CvMatchesService,
  ) {}

  async get(userId: string, sessionId: string): Promise<InterviewGapReport> {
    const session = await this.sessions.findOne({ where: { id: sessionId, userId } });
    if (!session) throw new NotFoundException('Interview session not found');

    const matchId = session.cvMatchId ?? null;
    const empty: InterviewGapReport = {
      session_id: sessionId,
      match_id: matchId,
      interviewer_summary: '',
      gap_items: [],
    };
    if (!session.finalAiRequestId) return empty;

    const row = await this.aiResults.findOne({
      where: { aiRequestId: session.finalAiRequestId, resultType: 'interview_scoring' },
    });
    const parsed = (row?.parsedResponse ?? {}) as {
      ai_feedback?: { summary?: unknown };
      interview_gap_items?: unknown;
    };
    const summary =
      typeof parsed.ai_feedback?.summary === 'string' ? parsed.ai_feedback.summary : '';
    const items = coerceInterviewGapItems(parsed.interview_gap_items);
    const context = await this.loadGapContext(userId, matchId);
    const grounded = groundInterviewGaps(items, context?.probedSet ?? null);

    const linked = context
      ? grounded.map((item) =>
          item.skill_canonical && context.reqIdByCanonical.has(item.skill_canonical)
            ? {
                ...item,
                requirement_id:
                  context.reqIdByCanonical.get(item.skill_canonical) ?? item.requirement_id,
              }
            : item,
        )
      : grounded;

    return {
      session_id: sessionId,
      match_id: matchId,
      interviewer_summary: summary,
      gap_items: linked,
    };
  }

  async getLatestForMatch(userId: string, matchId: string): Promise<InterviewGapReport | null> {
    const session = await this.sessions.findOne({
      where: {
        userId,
        cvMatchId: matchId,
        status: 'COMPLETED',
        finalAiRequestId: Not(IsNull()),
      },
      order: { endedAt: 'DESC', createdAt: 'DESC' },
    });
    if (!session) return null;
    return this.get(userId, session.id);
  }

  private async loadGapContext(
    userId: string,
    matchId: string | null,
  ): Promise<{ probedSet: Set<string>; reqIdByCanonical: Map<string, string> } | null> {
    if (!matchId || !this.cvMatches) return null;
    try {
      const report = await this.cvMatches.getGapReport(userId, matchId);
      const probedSet = new Set<string>();
      const reqIdByCanonical = new Map<string, string>();
      for (const gap of report.gap_items) {
        if (!gap.canonical_name) continue;
        const canonical = gap.canonical_name.toLowerCase();
        probedSet.add(canonical);
        reqIdByCanonical.set(canonical, gap.requirement_id);
      }
      return { probedSet, reqIdByCanonical };
    } catch {
      return null;
    }
  }
}

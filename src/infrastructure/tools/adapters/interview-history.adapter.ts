import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { InterviewSessionEntity } from '../../../database/entities/interview-session.entity';
import { ToolAdapter, ToolContext } from '../types';

export interface InterviewHistoryResult {
  has_history: boolean;
  sessions: Array<{
    target_role: string;
    interview_type: string;
    overall_score: number | null;
    when: string;
  }>;
}

const MAX_SESSIONS = 3;

/** numeric(5,2) columns hydrate as strings ("82.00") — the LLM should see numbers. */
const numberOrNull = (value: string | null): number | null => {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * Reads the CURRENT user's own recent mock-interview results for the chat tool loop. COMPLETED
 * rows can still carry NULL scores (stale-session sweeps), so only scored sessions count as
 * honest history — same filter as the platform's `scoredOnly` list.
 */
@Injectable()
export class InterviewHistoryAdapter implements ToolAdapter<
  Record<string, never>,
  InterviewHistoryResult
> {
  readonly name = 'interview.history';

  constructor(
    @InjectRepository(InterviewSessionEntity)
    private readonly sessions: Repository<InterviewSessionEntity>,
  ) {}

  argsSchema(_args: unknown): Record<string, never> {
    // No model-supplied arguments by design: always ctx.userId's own sessions.
    return {};
  }

  async invoke(_args: Record<string, never>, ctx: ToolContext): Promise<InterviewHistoryResult> {
    if (!ctx.userId) return { has_history: false, sessions: [] };
    const rows = await this.sessions.find({
      where: { userId: ctx.userId, status: 'COMPLETED', overallScore: Not(IsNull()) },
      order: { startedAt: 'DESC' },
      take: MAX_SESSIONS,
    });
    return {
      has_history: rows.length > 0,
      sessions: rows.map((row) => ({
        target_role: row.targetRole,
        interview_type: row.interviewType,
        overall_score: numberOrNull(row.overallScore),
        when: row.startedAt.toISOString().slice(0, 10),
      })),
    };
  }
}

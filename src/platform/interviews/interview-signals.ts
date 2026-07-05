import { Logger } from '@nestjs/common';
import { IsNull, Not, Repository } from 'typeorm';
import { InterviewSessionEntity } from '../../database/entities/interview-session.entity';
import { coerceInterviewGapItems } from '../../modules/interview/interview-gap';

export type InterviewSignalMap = Map<string, { risk: number; ref: string }>;

const logger = new Logger('InterviewSignals');

/**
 * V1 (Wave VALUE_CHAIN): canonical → worst REAL interview outcome for this match, from the latest
 * COMPLETED session's persisted gap_items (already anti-fabrication-grounded at finalize — see
 * InterviewsService.finalize → groundInterviewGaps). Only skill-anchored weaknesses count
 * (knowledge_gap/evidence_gap with a canonical); max severity wins per canonical.
 *
 * SINGLE source of truth for this join (C1): CvMatchesService.getGapReport AND
 * TailorVerifierService.verify both build the gap report from these signals. Severity decides
 * top-8 recommended_actions membership (sort-then-slice in tailor-checklist), so if the two
 * callers ever fetched signals differently, the FE would render an action the verifier then
 * rejects with ACTION_NOT_FOUND. Do NOT reimplement this query per caller.
 *
 * Never-throw: any failure (or a missing repo in positional unit-test construction) degrades to
 * "no signals" — the gap report builds exactly as if no interview had happened.
 * ponytail: sessions WITHOUT persisted gap_items (legacy, pre-persist finalize) are skipped rather
 * than re-derived from ai_results — re-deriving lives in InterviewGapReportService, which calls
 * getGapReport back (recursion). Revisit only if legacy sessions ever matter here.
 */
export async function fetchInterviewSignals(
  sessions: Repository<InterviewSessionEntity> | undefined,
  userId: string,
  matchId: string,
): Promise<InterviewSignalMap | undefined> {
  if (!sessions) return undefined;
  try {
    const session = await sessions.findOne({
      where: { userId, cvMatchId: matchId, status: 'COMPLETED', gapItems: Not(IsNull()) },
      order: { endedAt: 'DESC', createdAt: 'DESC' },
    });
    if (!session) return undefined;
    const ref = session.id.slice(0, 8);
    const map: InterviewSignalMap = new Map();
    for (const item of coerceInterviewGapItems(session.gapItems)) {
      if (item.weakness_type !== 'knowledge_gap' && item.weakness_type !== 'evidence_gap') {
        continue;
      }
      if (!item.skill_canonical) continue;
      const prev = map.get(item.skill_canonical);
      if (!prev || item.severity > prev.risk) {
        map.set(item.skill_canonical, { risk: item.severity, ref });
      }
    }
    return map.size ? map : undefined;
  } catch (err) {
    logger.warn(`interview signal fetch failed for gap-report (match ${matchId}): ${String(err)}`);
    return undefined;
  }
}

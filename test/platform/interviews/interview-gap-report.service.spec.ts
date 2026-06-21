import { NotFoundException } from '@nestjs/common';
import { InterviewGapReportService } from '../../../src/platform/interviews/interview-gap-report.service';

const sessionsRepo = (session: unknown) => ({ findOne: jest.fn().mockResolvedValue(session) });
const aiResultsRepo = (row: unknown) => ({ findOne: jest.fn().mockResolvedValue(row) });

const GAP_ITEM = {
  target_type: 'skill',
  skill_canonical: 'react',
  display_name: 'React',
  weakness_type: 'knowledge_gap',
  severity: 0.7,
  evidence_from_answer: 'thin',
  recommended_action: 'study',
  linked_question_id: '2',
};

describe('InterviewGapReportService.get', () => {
  it('throws NotFound when the session is missing or not owned', async () => {
    const svc = new InterviewGapReportService(
      sessionsRepo(null) as never,
      aiResultsRepo(null) as never,
      undefined,
    );

    await expect(svc.get('u1', 's1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns an empty report when the session has no finalAiRequestId yet', async () => {
    const svc = new InterviewGapReportService(
      sessionsRepo({ id: 's1', userId: 'u1', cvMatchId: 'm1', finalAiRequestId: null }) as never,
      aiResultsRepo(null) as never,
      undefined,
    );

    await expect(svc.get('u1', 's1')).resolves.toEqual({
      session_id: 's1',
      match_id: 'm1',
      interviewer_summary: '',
      gap_items: [],
    });
  });

  it('prefers persisted session.gapItems from the new interview chain', async () => {
    const svc = new InterviewGapReportService(
      sessionsRepo({
        id: 's1',
        userId: 'u1',
        cvMatchId: 'm1',
        finalAiRequestId: null,
        gapItems: [GAP_ITEM],
        coaching: { summary: 'New chain summary.' },
      }) as never,
      aiResultsRepo(null) as never,
      undefined,
    );

    await expect(svc.get('u1', 's1')).resolves.toMatchObject({
      session_id: 's1',
      match_id: 'm1',
      interviewer_summary: 'New chain summary.',
      gap_items: [expect.objectContaining({ display_name: 'React' })],
    });
  });

  it('reads and coerces interview_gap_items from ai_results.parsed_response', async () => {
    const svc = new InterviewGapReportService(
      sessionsRepo({ id: 's1', userId: 'u1', cvMatchId: null, finalAiRequestId: 'req1' }) as never,
      aiResultsRepo({
        parsedResponse: { ai_feedback: { summary: 'ok' }, interview_gap_items: [GAP_ITEM] },
      }) as never,
      undefined,
    );

    const out = await svc.get('u1', 's1');

    expect(out.interviewer_summary).toBe('ok');
    expect(out.gap_items).toHaveLength(1);
    expect(out.gap_items[0].requirement_id).toBeNull();
  });

  it('falls back to gap_items=[] when parsed_response is malformed', async () => {
    const svc = new InterviewGapReportService(
      sessionsRepo({ id: 's1', userId: 'u1', cvMatchId: null, finalAiRequestId: 'req1' }) as never,
      aiResultsRepo({ parsedResponse: { interview_gap_items: 'garbage' } }) as never,
      undefined,
    );

    await expect(svc.get('u1', 's1')).resolves.toMatchObject({ gap_items: [] });
  });

  it('best-effort links requirement_id from the match gap report by canonical name', async () => {
    const cvMatches = {
      getGapReport: jest.fn().mockResolvedValue({
        gap_items: [{ canonical_name: 'react', requirement_id: 'jd:hard_skill:react' }],
      }),
    };
    const svc = new InterviewGapReportService(
      sessionsRepo({ id: 's1', userId: 'u1', cvMatchId: 'm1', finalAiRequestId: 'req1' }) as never,
      aiResultsRepo({ parsedResponse: { interview_gap_items: [GAP_ITEM] } }) as never,
      cvMatches as never,
    );

    const out = await svc.get('u1', 's1');

    expect(out.gap_items[0].requirement_id).toBe('jd:hard_skill:react');
    expect(cvMatches.getGapReport).toHaveBeenCalledWith('u1', 'm1');
  });

  it('grounds out a fabricated skill gap whose skill is not in the match gap report', async () => {
    const cvMatches = {
      getGapReport: jest.fn().mockResolvedValue({
        gap_items: [{ canonical_name: 'react', requirement_id: 'jd:hard_skill:react' }],
      }),
    };
    const svc = new InterviewGapReportService(
      sessionsRepo({ id: 's1', userId: 'u1', cvMatchId: 'm1', finalAiRequestId: 'req1' }) as never,
      aiResultsRepo({
        parsedResponse: { interview_gap_items: [{ ...GAP_ITEM, skill_canonical: 'graphql' }] },
      }) as never,
      cvMatches as never,
    );

    await expect(svc.get('u1', 's1')).resolves.toMatchObject({ gap_items: [] });
  });

  it('does not throw if linkage fails', async () => {
    const cvMatches = { getGapReport: jest.fn().mockRejectedValue(new Error('boom')) };
    const svc = new InterviewGapReportService(
      sessionsRepo({ id: 's1', userId: 'u1', cvMatchId: 'm1', finalAiRequestId: 'req1' }) as never,
      aiResultsRepo({ parsedResponse: { interview_gap_items: [GAP_ITEM] } }) as never,
      cvMatches as never,
    );

    const out = await svc.get('u1', 's1');

    expect(out.gap_items[0].requirement_id).toBeNull();
  });
});

describe('InterviewGapReportService.getLatestForMatch', () => {
  it('returns null when the match has no completed scored session', async () => {
    const sessions = { findOne: jest.fn().mockResolvedValue(null) };
    const svc = new InterviewGapReportService(
      sessions as never,
      aiResultsRepo(null) as never,
      undefined,
    );

    await expect(svc.getLatestForMatch('u1', 'm1')).resolves.toBeNull();
    expect(sessions.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.arrayContaining([
          expect.objectContaining({ userId: 'u1', cvMatchId: 'm1', status: 'COMPLETED' }),
        ]),
      }),
    );
  });

  it('returns the report for the latest completed scored session on the match', async () => {
    const sessions = {
      findOne: jest
        .fn()
        .mockResolvedValueOnce({
          id: 's-latest',
          userId: 'u1',
          cvMatchId: 'm1',
          status: 'COMPLETED',
          finalAiRequestId: 'req1',
        })
        .mockResolvedValueOnce({
          id: 's-latest',
          userId: 'u1',
          cvMatchId: 'm1',
          finalAiRequestId: 'req1',
        }),
    };
    const svc = new InterviewGapReportService(
      sessions as never,
      aiResultsRepo({
        parsedResponse: { ai_feedback: { summary: 'ok' }, interview_gap_items: [GAP_ITEM] },
      }) as never,
      undefined,
    );

    const out = await svc.getLatestForMatch('u1', 'm1');

    expect(out).toMatchObject({ session_id: 's-latest', match_id: 'm1' });
    expect(out?.gap_items).toHaveLength(1);
  });
});

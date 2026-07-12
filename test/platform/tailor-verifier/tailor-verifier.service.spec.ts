import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TailorVerifierService } from '../../../src/platform/tailor-verifier/tailor-verifier.service';

/**
 * PR4.5 — platform loader for the server-verified tailor rewrite. Verifies the ownership chain
 * (route cvId === match.cvId === a CV owned by the caller), rejects legacy/un-reviewed matches,
 * then delegates the action decision to the pure verifyTailorAction (covered separately).
 */
describe('TailorVerifierService', () => {
  const SQL_BULLET = 'Optimized SQL queries to cut API latency by 30%';

  const review = {
    document: {
      language: 'en',
      contact: { name: null, email: null, phone: null, location: null, links: [] },
      summary: 'Backend developer',
      education: [],
      experience: [],
      projects: [{ name: 'Booking App', role: null, tech: [], bullets: [SQL_BULLET], link: null }],
      skills: { technical: [], soft: [], languages: [], tools: [] },
      certifications: [],
      activities: [],
    },
    evidence_ledger: null,
  };

  const recommendedAction = {
    action_type: 'deepen_wording',
    skill_canonical: 'sql',
    display_name: 'SQL',
    why: 'why',
    rewrite_eligible: true,
    anchor: { kind: 'project', ref: 'Booking App' },
    jd_importance: 'REQUIRED',
    jd_count: 3,
    cv_count: 1,
    cv_level: 2,
    required_level: 4,
    action_id: 'deepen_wording:sql',
    requirement_id: 'jd:hard_skill:sql',
    fixability: 'rewrite',
    cv_section: 'Project: Booking App',
    anchor_confidence: 'high',
    before: SQL_BULLET,
    target_section: null,
    insertion_hint: null,
  };

  function build(opts: { interviewSessions?: { findOne: jest.Mock } } = {}) {
    const matches = {
      findOne: jest.fn().mockResolvedValue({ id: 'match-1', cvId: 'cv-1', aiResultId: 'ai-1' }),
    };
    const aiResults = {
      findOne: jest.fn().mockResolvedValue({ id: 'ai-1', parsedResponse: { overall_score: 70 } }),
      manager: { query: jest.fn().mockResolvedValue([{ parsed_response: review }]) },
    };
    const cvs = {
      findOne: jest.fn().mockResolvedValue({ id: 'cv-1', userId: 'user-1', deletedAt: null }),
    };
    const gapReport = {
      build: jest.fn().mockResolvedValue({ recommended_actions: [recommendedAction] }),
    };
    const service = new TailorVerifierService(
      matches as never,
      aiResults as never,
      cvs as never,
      gapReport as never,
      opts.interviewSessions as never,
    );
    return { service, matches, aiResults, cvs, gapReport };
  }

  const input = {
    userId: 'user-1',
    cvId: 'cv-1',
    matchId: 'match-1',
    actionId: 'deepen_wording:sql',
    text: SQL_BULLET,
  };

  it('happy path: rebuilds the gap report and returns the verified action', async () => {
    const { service, gapReport, cvs } = build();
    const v = await service.verify(input);
    expect(cvs.findOne).toHaveBeenCalledWith({
      where: { id: 'cv-1', userId: 'user-1', deletedAt: expect.anything() },
    });
    expect(gapReport.build).toHaveBeenCalledWith(
      expect.objectContaining({ match: { overall_score: 70 }, review, lang: 'vi' }),
    );
    expect(v).toEqual({
      action_id: 'deepen_wording:sql',
      action_type: 'deepen_wording',
      skill_canonical: 'sql',
      skill_display: 'SQL',
      cv_level: 2,
      required_level: 4,
    });
  });

  it('rejects when the match does not exist', async () => {
    const { service, matches, gapReport } = build();
    matches.findOne.mockResolvedValue(null);
    await expect(service.verify(input)).rejects.toBeInstanceOf(NotFoundException);
    expect(gapReport.build).not.toHaveBeenCalled();
  });

  it('rejects when match.cvId differs from the route cvId (confused deputy)', async () => {
    const { service, matches, cvs, gapReport } = build();
    matches.findOne.mockResolvedValue({ id: 'match-1', cvId: 'other-cv', aiResultId: 'ai-1' });
    await expect(service.verify(input)).rejects.toBeInstanceOf(NotFoundException);
    expect(cvs.findOne).not.toHaveBeenCalled();
    expect(gapReport.build).not.toHaveBeenCalled();
  });

  it('rejects when the CV is not owned by the caller', async () => {
    const { service, cvs, gapReport } = build();
    cvs.findOne.mockResolvedValue(null);
    await expect(service.verify(input)).rejects.toBeInstanceOf(NotFoundException);
    expect(gapReport.build).not.toHaveBeenCalled();
  });

  it('rejects a legacy match without a stored AI result (MATCH_TOO_OLD)', async () => {
    const { service, matches, aiResults, gapReport } = build();
    matches.findOne.mockResolvedValue({ id: 'match-1', cvId: 'cv-1', aiResultId: null });
    await expect(service.verify(input)).rejects.toMatchObject({
      response: { code: 'MATCH_TOO_OLD' },
    });
    expect(aiResults.findOne).not.toHaveBeenCalled();
    expect(gapReport.build).not.toHaveBeenCalled();
  });

  it('rejects when the stored ai_results parsed response is gone/empty', async () => {
    const { service, aiResults, gapReport } = build();
    aiResults.findOne.mockResolvedValue({ id: 'ai-1', parsedResponse: null });
    await expect(service.verify(input)).rejects.toBeInstanceOf(NotFoundException);
    expect(gapReport.build).not.toHaveBeenCalled();
  });

  it('rejects when there is no CV review yet (NO_REVIEW — run diagnosis first)', async () => {
    const { service, aiResults, gapReport } = build();
    aiResults.manager.query.mockResolvedValue([]); // no review row
    await expect(service.verify(input)).rejects.toMatchObject({ response: { code: 'NO_REVIEW' } });
    expect(gapReport.build).not.toHaveBeenCalled();
  });

  it('propagates the verifier decision (arbitrary text → BadRequest from verifyTailorAction)', async () => {
    const { service } = build();
    await expect(
      service.verify({ ...input, text: 'totally unrelated fabricated text' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  /**
   * C1 (Wave VALUE_CHAIN) — getGapReport now feeds real interview outcomes (interviewSignals) into
   * the gap-report build, and severity decides top-8 recommended_actions MEMBERSHIP (sort-then-slice
   * in tailor-checklist). The verifier's rebuild MUST use the SAME signals, or an action the FE
   * rendered gets rejected with ACTION_NOT_FOUND after a completed interview.
   */
  describe('interview signals parity with getGapReport', () => {
    const completedSession = {
      id: 'sess-abc-full-id',
      gapItems: [
        {
          weakness_type: 'knowledge_gap',
          skill_canonical: 'sql',
          display_name: 'SQL',
          severity: 0.8,
          evidence_from_answer: 'struggled with indexing question',
          recommended_action: 'review indexing',
          linked_question_id: 'q1',
          target_type: 'skill',
          requirement_id: null,
        },
      ],
    };

    it('rebuilds the gap report WITH the latest completed interview signals (same query, same map)', async () => {
      const interviewSessions = { findOne: jest.fn().mockResolvedValue(completedSession) };
      const { service, gapReport } = build({ interviewSessions });
      // Simulate the severity→top-8 membership effect: the action the FE rendered only exists in
      // the report when the interview signals are threaded into the build (as getGapReport did).
      gapReport.build.mockImplementation(({ interviewSignals }: never) =>
        Promise.resolve({
          recommended_actions: interviewSignals ? [recommendedAction] : [],
        }),
      );

      const v = await service.verify(input);
      expect(v.action_id).toBe('deepen_wording:sql');

      // Same query semantics as CvMatchesService.fetchInterviewSignals.
      expect(interviewSessions.findOne).toHaveBeenCalledWith({
        where: expect.objectContaining({
          userId: 'user-1',
          cvMatchId: 'match-1',
          status: 'COMPLETED',
        }),
        order: { endedAt: 'DESC', createdAt: 'DESC' },
      });

      // Same map shape getGapReport passes: canonical → { risk, ref: sessionId.slice(0, 8), display }.
      const call = gapReport.build.mock.calls[0][0] as {
        interviewSignals?: Map<string, { risk: number; ref: string; display: string }>;
      };
      expect(call.interviewSignals).toBeInstanceOf(Map);
      expect(call.interviewSignals?.get('sql')).toEqual({
        risk: 0.8,
        ref: 'sess-abc',
        display: 'SQL',
      });
    });

    it('never-throws: signal fetch failure degrades to no-signals (verification still runs)', async () => {
      const interviewSessions = { findOne: jest.fn().mockRejectedValue(new Error('db down')) };
      const { service, gapReport } = build({ interviewSessions });
      const v = await service.verify(input);
      expect(v.action_id).toBe('deepen_wording:sql');
      expect(gapReport.build).toHaveBeenCalledWith(
        expect.objectContaining({ interviewSignals: undefined }),
      );
    });
  });
});

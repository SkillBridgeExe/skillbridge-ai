import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CanonicalCvDocument } from '../../../src/common/types/canonical-cv';
import { PatchedTailorAction } from '../../../src/modules/cv-jd-match/cv-patch';
import { verifyTailorAction } from '../../../src/modules/cv-builder/tailor-verification';

/**
 * PR4.5 — the deterministic gate that turns an FE action_id into a TRUSTED rewrite instruction.
 * These mirror the acceptance criteria: a forged/unknown action is rejected; missing_required /
 * add_evidence never reach the LLM; deepen_wording needs a real `before`; emphasize/deepen on the
 * candidate's own content pass; arbitrary FE text is rejected.
 */
describe('verifyTailorAction (pure)', () => {
  const SQL_BULLET = 'Optimized SQL queries to cut API latency by 30%';
  const doc: CanonicalCvDocument = {
    language: 'en',
    contact: { name: null, email: null, phone: null, location: null, links: [] },
    summary: 'Backend developer focused on data-heavy services',
    education: [],
    experience: [],
    projects: [{ name: 'Booking App', role: null, tech: [], bullets: [SQL_BULLET], link: null }],
    skills: { technical: [], soft: [], languages: [], tools: [] },
    certifications: [],
    activities: [],
  };

  const base = (over: Partial<PatchedTailorAction>): PatchedTailorAction => ({
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
    cv_section: 'Dự án: Booking App',
    anchor_confidence: 'high',
    before: SQL_BULLET,
    target_section: null,
    insertion_hint: null,
    ...over,
  });

  // Assert the call throws an HttpException whose response body carries the expected `code`.
  const expectThrowCode = (fn: () => unknown, code: string): void => {
    let thrown: unknown;
    expect(() => {
      try {
        fn();
      } catch (e) {
        thrown = e;
        throw e;
      }
    }).toThrow();
    const body = (thrown as BadRequestException | NotFoundException).getResponse() as {
      code?: string;
    };
    expect(body.code).toBe(code);
  };

  it('unknown/forged action_id → ACTION_NOT_FOUND (404)', () => {
    expect(() =>
      verifyTailorAction([base({})], { actionId: 'deepen_wording:python', text: SQL_BULLET }, doc),
    ).toThrow(NotFoundException);
    expectThrowCode(
      () =>
        verifyTailorAction(
          [base({})],
          { actionId: 'deepen_wording:python', text: SQL_BULLET },
          doc,
        ),
      'ACTION_NOT_FOUND',
    );
  });

  it('missing_required → ACTION_NOT_REWRITABLE (advise-only, never rewritten)', () => {
    const action = base({
      action_type: 'missing_required',
      action_id: 'missing_required:kubernetes',
      skill_canonical: 'kubernetes',
      display_name: 'Kubernetes',
      rewrite_eligible: false,
      fixability: 'learn',
      before: null,
      anchor_confidence: null,
    });
    expectThrowCode(
      () => verifyTailorAction([action], { actionId: action.action_id, text: 'anything' }, doc),
      'ACTION_NOT_REWRITABLE',
    );
  });

  it('add_evidence → ACTION_NOT_REWRITABLE', () => {
    const action = base({
      action_type: 'add_evidence',
      action_id: 'add_evidence:react',
      skill_canonical: 'react',
      display_name: 'React',
      rewrite_eligible: false,
      fixability: 'add_evidence',
      before: null,
      anchor_confidence: null,
    });
    expectThrowCode(
      () => verifyTailorAction([action], { actionId: action.action_id, text: 'anything' }, doc),
      'ACTION_NOT_REWRITABLE',
    );
  });

  it('deepen_wording with a verified before + text===before → returns verified action', () => {
    const v = verifyTailorAction(
      [base({})],
      { actionId: 'deepen_wording:sql', text: SQL_BULLET },
      doc,
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

  it('deepen_wording with a low-confidence anchor (before=null) → NO_ANCHOR', () => {
    expectThrowCode(
      () =>
        verifyTailorAction(
          [base({ before: null, anchor_confidence: 'low' })],
          { actionId: 'deepen_wording:sql', text: SQL_BULLET },
          doc,
        ),
      'NO_ANCHOR',
    );
  });

  it('deepen_wording with fixability!=rewrite → NO_ANCHOR (not eligible to reword)', () => {
    expectThrowCode(
      () =>
        verifyTailorAction(
          [base({ fixability: 'add_evidence' })],
          { actionId: 'deepen_wording:sql', text: SQL_BULLET },
          doc,
        ),
      'NO_ANCHOR',
    );
  });

  it('deepen_wording with arbitrary FE text (not before, not a CV bullet) → TEXT_NOT_IN_CV', () => {
    expectThrowCode(
      () =>
        verifyTailorAction(
          [base({})],
          { actionId: 'deepen_wording:sql', text: 'I am an expert in SQL and everything else' },
          doc,
        ),
      'TEXT_NOT_IN_CV',
    );
  });

  it('deepen_wording: a DIFFERENT real CV bullet that even mentions the SAME skill → TEXT_NOT_IN_CV (strict: must target the anchored before)', () => {
    // Review fix: `before` is bullet A; the client submits bullet B. B is a genuine CV bullet that
    // ALSO mentions SQL — yet it is NOT the located anchor, so the deepen rewrite must be rejected
    // (otherwise the "deepen SQL on bullet A" instruction would be redirected onto bullet B).
    const OTHER_SQL_BULLET = 'Designed SQL schemas and indexes for the reporting service';
    const docWithTwoSql: CanonicalCvDocument = {
      ...doc,
      projects: [
        {
          name: 'Booking App',
          role: null,
          tech: [],
          bullets: [SQL_BULLET, OTHER_SQL_BULLET],
          link: null,
        },
      ],
    };
    expectThrowCode(
      () =>
        verifyTailorAction(
          [base({})], // before = SQL_BULLET (bullet A)
          { actionId: 'deepen_wording:sql', text: OTHER_SQL_BULLET }, // client sends bullet B
          docWithTwoSql,
        ),
      'TEXT_NOT_IN_CV',
    );
  });

  it('emphasize on the candidate summary (a real document field) → returns verified action', () => {
    const action = base({
      action_type: 'emphasize',
      action_id: 'emphasize:sql',
      rewrite_eligible: true,
      fixability: null,
      before: null,
      anchor_confidence: null,
      target_section: 'Booking App',
      insertion_hint: 'hint',
    });
    const v = verifyTailorAction([action], { actionId: 'emphasize:sql', text: doc.summary }, doc);
    expect(v.action_type).toBe('emphasize');
    expect(v.skill_display).toBe('SQL');
  });

  it('emphasize with arbitrary FE text → TEXT_NOT_IN_CV', () => {
    const action = base({
      action_type: 'emphasize',
      action_id: 'emphasize:sql',
      before: null,
      fixability: null,
    });
    expectThrowCode(
      () =>
        verifyTailorAction(
          [action],
          { actionId: 'emphasize:sql', text: 'made up summary that is not in the CV' },
          doc,
        ),
      'TEXT_NOT_IN_CV',
    );
  });
});

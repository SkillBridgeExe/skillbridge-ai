/**
 * Pins the CURRENT behavior of the pure PR4.5 gate verifyTailorAction() — every rejection code
 * path plus the success paths. No DB, no LLM: actions/document are built inline.
 */
import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import { CanonicalCvDocument, emptyCanonicalCv } from '../../common/types/canonical-cv';
import { PatchedTailorAction } from '../cv-jd-match/cv-patch';
import { verifyTailorAction } from './tailor-verification';

const BEFORE = 'Built REST APIs with NestJS serving 10k users';
const OTHER_BULLET = 'Improved NestJS test coverage from 40% to 90%';
const SUMMARY = 'Backend developer focused on Node.js services';

function makeAction(overrides: Partial<PatchedTailorAction> = {}): PatchedTailorAction {
  return {
    action_type: 'deepen_wording',
    skill_canonical: 'nestjs',
    display_name: 'NestJS',
    why: 'why',
    rewrite_eligible: true,
    anchor: { kind: 'experience', ref: 'FPT — BE' },
    jd_importance: null,
    jd_count: 3,
    cv_count: 1,
    cv_level: 2,
    required_level: 3,
    action_id: 'deepen_wording:nestjs',
    requirement_id: null,
    fixability: 'rewrite',
    cv_section: 'Kinh nghiệm: FPT — BE',
    anchor_confidence: 'high',
    before: BEFORE,
    target_section: null,
    insertion_hint: null,
    ...overrides,
  };
}

function makeDoc(): CanonicalCvDocument {
  const doc = emptyCanonicalCv('vi');
  doc.summary = SUMMARY;
  doc.experience.push({
    org: 'FPT',
    role: 'BE',
    start: null,
    end: null,
    location: null,
    bullets: [BEFORE, OTHER_BULLET],
  });
  return doc;
}

function expectCode(fn: () => unknown, ctor: new (...args: never[]) => Error, code: string): void {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ctor);
  expect((err as HttpException).getResponse()).toMatchObject({ code });
}

describe('verifyTailorAction', () => {
  describe('ACTION_NOT_FOUND', () => {
    it('throws 404 ACTION_NOT_FOUND for an unknown action_id', () => {
      expectCode(
        () =>
          verifyTailorAction(
            [makeAction()],
            { actionId: 'deepen_wording:react', text: BEFORE },
            makeDoc(),
          ),
        NotFoundException,
        'ACTION_NOT_FOUND',
      );
    });

    it('has NO composite fallback: lookup is exact action_id equality only', () => {
      // The composite form `${action_type}:${skill_canonical}` resolves ONLY because
      // decorateWithPatch builds action_id that way — if the stored id differs, the composite misses.
      const action = makeAction({ action_id: 'some-other-id' });
      expectCode(
        () =>
          verifyTailorAction(
            [action],
            { actionId: 'deepen_wording:nestjs', text: BEFORE },
            makeDoc(),
          ),
        NotFoundException,
        'ACTION_NOT_FOUND',
      );
      // And the stored id itself resolves.
      expect(
        verifyTailorAction([action], { actionId: 'some-other-id', text: BEFORE }, makeDoc())
          .action_id,
      ).toBe('some-other-id');
    });
  });

  describe('ACTION_NOT_REWRITABLE', () => {
    it('rejects rewrite_eligible=false — checked BEFORE the anchor, so it wins over NO_ANCHOR', () => {
      const action = makeAction({ rewrite_eligible: false, before: null, fixability: 'learn' });
      expectCode(
        () => verifyTailorAction([action], { actionId: action.action_id, text: BEFORE }, makeDoc()),
        BadRequestException,
        'ACTION_NOT_REWRITABLE',
      );
    });

    it.each(['missing_required', 'add_evidence'] as const)(
      'rejects %s even when rewrite_eligible=true',
      (actionType) => {
        const action = makeAction({ action_type: actionType, action_id: `${actionType}:nestjs` });
        expectCode(
          () =>
            verifyTailorAction([action], { actionId: action.action_id, text: BEFORE }, makeDoc()),
          BadRequestException,
          'ACTION_NOT_REWRITABLE',
        );
      },
    );
  });

  describe('NO_ANCHOR (deepen_wording)', () => {
    it('rejects when fixability !== "rewrite", even with a before present', () => {
      const action = makeAction({ fixability: 'learn' });
      expectCode(
        () => verifyTailorAction([action], { actionId: action.action_id, text: BEFORE }, makeDoc()),
        BadRequestException,
        'NO_ANCHOR',
      );
    });

    it('rejects a low-confidence anchor (before=null) even when fixability="rewrite"', () => {
      const action = makeAction({ before: null, anchor_confidence: 'low' });
      expectCode(
        () => verifyTailorAction([action], { actionId: action.action_id, text: BEFORE }, makeDoc()),
        BadRequestException,
        'NO_ANCHOR',
      );
    });
  });

  describe('TEXT_NOT_IN_CV', () => {
    it('deepen: rejects another REAL CV bullet that names the same skill — only the exact before', () => {
      const action = makeAction();
      expectCode(
        () =>
          verifyTailorAction(
            [action],
            { actionId: action.action_id, text: OTHER_BULLET },
            makeDoc(),
          ),
        BadRequestException,
        'TEXT_NOT_IN_CV',
      );
    });

    it('deepen: rejects empty text (input.text ?? "" then trim)', () => {
      const action = makeAction();
      expectCode(
        () => verifyTailorAction([action], { actionId: action.action_id, text: '' }, makeDoc()),
        BadRequestException,
        'TEXT_NOT_IN_CV',
      );
    });

    it('emphasize: rejects arbitrary FE text not present in the document', () => {
      const action = makeAction({ action_type: 'emphasize', action_id: 'emphasize:nestjs' });
      expectCode(
        () =>
          verifyTailorAction(
            [action],
            { actionId: action.action_id, text: 'invented text' },
            makeDoc(),
          ),
        BadRequestException,
        'TEXT_NOT_IN_CV',
      );
    });

    it('emphasize: rejects when document is null (nothing to match against)', () => {
      const action = makeAction({ action_type: 'emphasize', action_id: 'emphasize:nestjs' });
      expectCode(
        () => verifyTailorAction([action], { actionId: action.action_id, text: SUMMARY }, null),
        BadRequestException,
        'TEXT_NOT_IN_CV',
      );
    });
  });

  describe('success', () => {
    it('deepen: exact before match returns ONLY the server-trusted subset', () => {
      const action = makeAction();
      const verified = verifyTailorAction(
        [action],
        { actionId: action.action_id, text: BEFORE },
        makeDoc(),
      );
      // Exact shape pin: nothing FE-controllable leaks through.
      expect(verified).toEqual({
        action_id: 'deepen_wording:nestjs',
        action_type: 'deepen_wording',
        skill_canonical: 'nestjs',
        skill_display: 'NestJS',
        cv_level: 2,
        required_level: 3,
      });
    });

    it('deepen: compares text.trim() === before.trim() (edge whitespace tolerated on both sides)', () => {
      const action = makeAction({ before: `  ${BEFORE}  ` });
      const verified = verifyTailorAction(
        [action],
        { actionId: action.action_id, text: `\n${BEFORE} ` },
        makeDoc(),
      );
      expect(verified.action_id).toBe('deepen_wording:nestjs');
    });

    it('deepen: never consults the document — passes even with document=null', () => {
      // Pinned surprise: the deepen path trusts the server-located `before` alone; only the
      // emphasize path checks isDocumentBullet.
      const action = makeAction();
      expect(
        verifyTailorAction([action], { actionId: action.action_id, text: BEFORE }, null)
          .action_type,
      ).toBe('deepen_wording');
    });

    it('emphasize: accepts the verbatim summary', () => {
      const action = makeAction({
        action_type: 'emphasize',
        action_id: 'emphasize:nestjs',
        before: null,
        anchor: null,
        fixability: null,
      });
      const verified = verifyTailorAction(
        [action],
        { actionId: action.action_id, text: `  ${SUMMARY}` },
        makeDoc(),
      );
      expect(verified.action_type).toBe('emphasize');
      expect(verified.skill_display).toBe('NestJS');
    });

    it('emphasize: accepts any verbatim experience bullet, even one unrelated to before', () => {
      const action = makeAction({ action_type: 'emphasize', action_id: 'emphasize:nestjs' });
      expect(
        verifyTailorAction([action], { actionId: action.action_id, text: OTHER_BULLET }, makeDoc())
          .action_id,
      ).toBe('emphasize:nestjs');
    });
  });
});

/**
 * Server-verified tailor action (PR4.5) — the DETERMINISTIC gate that turns an FE-supplied
 * `action_id` into a TRUSTED rewrite instruction source.
 *
 * WHY: the on-demand tailor rewrite (mode='tailor') used to build its LLM instruction from
 * skill/level fields the FE sent — the FE could dictate "foreground React at level 5" for a skill
 * the candidate never had. This pure function re-derives the action from the server-built gap
 * report (the same `recommended_actions[]` the FE rendered) and lets a rewrite proceed ONLY when:
 *   - the action_id exists in the CURRENT report,
 *   - it is rewrite-eligible AND of a rewritable type (emphasize | deepen_wording — never
 *     missing_required / add_evidence, which must be addressed honestly, not reworded),
 *   - deepen_wording has a HIGH-confidence anchor (a real `before` bullet) — a low-confidence
 *     anchor (before=null) is advise-only and must NOT reach the LLM as a rewrite,
 *   - for deepen_wording the submitted `text` is EXACTLY the located `before` bullet (never another
 *     CV bullet, even one mentioning the same skill — that would redirect the instruction); for
 *     emphasize the `text` is any verbatim document bullet / summary the user picked,
 *
 * The returned VerifiedTailorAction carries ONLY server-trusted facts; CvRewriteService builds the
 * instruction from it, ignoring any FE-sent skill/level. Pure: no LLM, no I/O, no Date.now/random.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CanonicalCvDocument } from '../../common/types/canonical-cv';
import { PatchedTailorAction, isDocumentBullet } from '../cv-jd-match/cv-patch';

/** The trusted subset CvRewriteService is allowed to build a tailor instruction from. */
export interface VerifiedTailorAction {
  action_id: string;
  action_type: 'emphasize' | 'deepen_wording';
  /** Canonical + display skill name straight from the server-built gap report (never the FE). */
  skill_canonical: string;
  skill_display: string;
  cv_level: number | null;
  required_level: number | null;
}

export interface VerifyTailorActionInput {
  /** The stable id (`${action_type}:${skill_canonical}`) the FE selected from the gap report. */
  actionId: string;
  /** The exact CV field text the user is about to rewrite (a bullet or the summary). */
  text: string;
}

/**
 * Verify an FE-selected tailor action against the freshly rebuilt gap report. Throws a typed
 * Http error (mapped to a clear 400/404 for the FE) when the action can't be trusted; returns the
 * trusted action otherwise. `actions` = report.recommended_actions; `document` = review.document.
 */
export function verifyTailorAction(
  actions: PatchedTailorAction[],
  input: VerifyTailorActionInput,
  document: CanonicalCvDocument | null,
): VerifiedTailorAction {
  const action = actions.find((a) => a.action_id === input.actionId);
  if (!action) {
    // The report is rebuilt deterministically; a miss means the FE sent a stale/forged id.
    throw new NotFoundException({
      code: 'ACTION_NOT_FOUND',
      message:
        'Gợi ý này không còn trong phân tích hiện tại — hãy chạy lại phân tích CV↔JD. / ' +
        'This suggestion is no longer in the current analysis — re-run the CV↔JD match.',
    });
  }

  if (
    !action.rewrite_eligible ||
    (action.action_type !== 'emphasize' && action.action_type !== 'deepen_wording')
  ) {
    // missing_required / add_evidence are advise-only: rewording can't manufacture a missing skill.
    throw new BadRequestException({
      code: 'ACTION_NOT_REWRITABLE',
      message:
        'Mục này không thể viết lại bằng AI (cần học/bổ sung bằng chứng thật). / ' +
        'This item cannot be AI-rewritten (it needs real learning/evidence, not rewording).',
    });
  }

  const text = (input.text ?? '').trim();

  if (action.action_type === 'deepen_wording') {
    // Blocking fix #2: only a HIGH-confidence anchor (a located real bullet) may be deepened.
    if (action.fixability !== 'rewrite' || !action.before) {
      throw new BadRequestException({
        code: 'NO_ANCHOR',
        message:
          'Chưa xác định được bullet thật để viết sâu hơn cho kỹ năng này. / ' +
          'No verified CV bullet was located to deepen for this skill.',
      });
    }
    // STRICT (review fix): a deepen rewrite may target ONLY the exact anchored bullet the server
    // located (`before`) — never another CV bullet, even one that mentions the same skill, which
    // would silently redirect the "deepen <skill>" instruction onto unrelated content. The located
    // `before` is, by construction (cv-patch.ts), a real bullet that already names the skill, so this
    // single equality subsumes the former document-bullet + skill-token checks.
    if (text !== action.before.trim()) {
      throw new BadRequestException({
        code: 'TEXT_NOT_IN_CV',
        message:
          'Chỉ viết lại được đúng bullet đã xác định cho gợi ý này. / ' +
          'This rewrite must target the exact CV bullet the analysis located.',
      });
    }
  } else {
    // emphasize = surface an UNDER-mentioned skill in the summary or a prominent bullet the user
    // picked. No skill-token requirement (the whole point is it is barely present yet), but the
    // chosen text must still be the candidate's own summary/bullet — never arbitrary FE text.
    if (!isDocumentBullet(document, text)) {
      throw new BadRequestException({
        code: 'TEXT_NOT_IN_CV',
        message:
          'Chọn một bullet hoặc summary đã có trong CV để làm nổi bật. / ' +
          'Pick an existing CV bullet or summary to emphasize.',
      });
    }
  }

  return {
    action_id: action.action_id,
    action_type: action.action_type,
    skill_canonical: action.skill_canonical,
    skill_display: action.display_name,
    cv_level: action.cv_level,
    required_level: action.required_level,
  };
}

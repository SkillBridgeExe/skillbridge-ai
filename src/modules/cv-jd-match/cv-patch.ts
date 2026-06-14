/**
 * CV Patch Engine (PR4) — a DETERMINISTIC "patch plan" over the tailor checklist.
 *
 * It does NOT recompute anything: it JOINs the already-built gap_items[] (the canonical gap/severity/
 * fixability source) onto the already-built recommended_actions[] (TailorAction[]) by skill_canonical
 * and enriches each action with the fields the FE needs to render an actionable fix — section, a
 * stable id, fixability, and (only when the evidence supports it) the verbatim CV `before` bullet.
 *
 * HARD RULES (owner): the LLM never decides a gap/severity/fixability/eligibility — those are all
 * code here. The on-demand rewrite (mode='tailor', unchanged) is the ONLY LLM and runs only when the
 * user clicks. NO fabrication: a `before` is emitted ONLY for a fixability==='rewrite' action whose
 * anchor resolves to a real demonstrated bullet in the CV; an uncertain anchor degrades to advise-only
 * (anchor_confidence='low', before=null) — never a guessed bullet. Pure: no LLM, no Date.now/random.
 */
import { TailorAction } from './tailor-checklist';
import { Fixability, GapItem } from '../gap-engine/gap-item';
import { CanonicalCvDocument } from '../../common/types/canonical-cv';

export type AnchorConfidence = 'high' | 'low' | null;

/** A TailorAction enriched into a patch-plan item. Strict SUPERSET — existing FE renders stay valid. */
export interface PatchedTailorAction extends TailorAction {
  /** Stable, deterministic id for FE dedupe/keying: `${action_type}:${skill_canonical}`. */
  action_id: string;
  /** The canonical GapItem this action addresses (FE dedupe + cross-flow tracking); null if none joins. */
  requirement_id: string | null;
  /** Echoed from the joined GapItem so FE/eval can branch without re-deriving. */
  fixability: Fixability | null;
  /** Localized CV-location label (e.g. "Kinh nghiệm: FPT — BE"); null when no anchor resolves. */
  cv_section: string | null;
  /** Confidence that the CV location is correct. 'low' (section known, exact bullet not) ⇒ no `before`. */
  anchor_confidence: AnchorConfidence;
  /** The EXACT existing CV bullet to reword — ONLY for a high-confidence 'rewrite' action. Else null. */
  before: string | null;
  /** emphasize only: a RAW ledger ref (e.g. "Booking App") of where the skill currently appears so the
   *  user can foreground it — NOT a localized label like `cv_section`. null when no evidence ref exists.
   *  FE: key dedupe on `action_id` (always present); `cv_section`/`target_section` are display-only. */
  target_section: string | null;
  /** emphasize only: a deterministic, localized hint on how to surface the skill (no rewrite). */
  insertion_hint: string | null;
}

type Lang = 'vi' | 'en';

const SECTION_LABEL: Record<Lang, Record<string, string>> = {
  vi: { experience: 'Kinh nghiệm', project: 'Dự án', activity: 'Hoạt động', summary: 'Tóm tắt' },
  en: { experience: 'Experience', project: 'Project', activity: 'Activity', summary: 'Summary' },
};
const EMPHASIZE_HINT: Record<Lang, (s: string) => string> = {
  vi: (s) =>
    `Đưa "${s}" vào summary hoặc một bullet nổi bật ở đầu mục liên quan (không cần sửa 1 bullet cụ thể).`,
  en: (s) =>
    `Surface "${s}" in the summary or a prominent top bullet of the relevant section (no single-bullet edit needed).`,
};

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Scanner-free, deterministic: does the bullet mention the skill as a whole token (no java⊂javascript)? */
function bulletMentions(bullet: string, tokens: string[]): boolean {
  return tokens.some((tok) => {
    const t = tok.trim();
    if (t.length < 2) return false;
    return new RegExp(`(?<![a-zA-Z0-9])${escapeRegex(t)}(?![a-zA-Z0-9])`, 'i').test(bullet);
  });
}

/** Resolve the anchored CV section (the bullets to search) from the demonstrated-source anchor.
 *  Returns the section label + its bullets, or null when the anchor can't be located in the document. */
function resolveSection(
  doc: CanonicalCvDocument,
  anchor: { kind: string; ref: string },
): { label: string; bullets: string[] } | null {
  const ref = anchor.ref;
  if (anchor.kind === 'experience') {
    const e = doc.experience.find(
      (x) =>
        `${x.org} — ${x.role ?? ''}`.trim() === ref ||
        `${x.org} — ${x.role}` === ref ||
        x.org === ref,
    );
    return e ? { label: e.role ? `${e.org} — ${e.role}` : e.org, bullets: e.bullets } : null;
  }
  if (anchor.kind === 'project') {
    const p = doc.projects.find((x) => x.name === ref);
    return p ? { label: p.name, bullets: p.bullets } : null;
  }
  if (anchor.kind === 'activity') {
    const a = doc.activities.find((x) => x.org === ref);
    return a ? { label: a.org, bullets: a.bullets } : null;
  }
  return null; // summary / skills_list / unknown kind → no bullet-level resolution
}

export interface DecoratePatchInput {
  actions: TailorAction[];
  gapItems: GapItem[];
  document: CanonicalCvDocument | null;
  lang: Lang;
}

/**
 * PURE: enrich each TailorAction into a PatchedTailorAction. Order/count/caps are preserved exactly
 * (one-to-one map — never adds, drops, or reorders). The patch plan is fully deterministic; the only
 * non-determinism in the whole feature is the separate, on-demand LLM rewrite that produces `after`.
 */
export function decorateWithPatch(input: DecoratePatchInput): PatchedTailorAction[] {
  const { actions, gapItems, document, lang } = input;
  const byCanonical = new Map(gapItems.map((g) => [g.canonical_name, g]));
  const labels = SECTION_LABEL[lang];

  return actions.map((a) => {
    const gi = byCanonical.get(a.skill_canonical) ?? null;
    const item: PatchedTailorAction = {
      ...a,
      action_id: `${a.action_type}:${a.skill_canonical}`,
      requirement_id: gi?.requirement_id ?? null,
      fixability: gi?.fixability ?? null,
      cv_section: null,
      anchor_confidence: null,
      before: null,
      target_section: null,
      insertion_hint: null,
    };

    // The ONLY before-emitting path: a demonstrated-evidence rewrite with a locatable bullet.
    if (a.action_type === 'deepen_wording' && gi?.fixability === 'rewrite' && a.anchor) {
      const section = document ? resolveSection(document, a.anchor) : null;
      if (section) {
        item.cv_section = `${labels[a.anchor.kind] ?? a.anchor.kind}: ${section.label}`;
        const hit = section.bullets.find(
          (b) => b && b.trim() && bulletMentions(b, [a.skill_canonical, a.display_name]),
        );
        if (hit) {
          item.anchor_confidence = 'high';
          item.before = hit.trim();
        } else {
          // Section is real (from the demonstrated ledger source) but the exact bullet isn't certain —
          // degrade to advise-only. NEVER guess a bullet (anti-fabrication).
          item.anchor_confidence = 'low';
        }
      }
      // no document / unresolved section → anchor_confidence stays null, before stays null
    }

    // emphasize is "surface this skill", not "reword one bullet" → no before; give a where + hint.
    if (a.action_type === 'emphasize') {
      item.target_section = gi?.evidence_refs?.[0] ?? null;
      item.insertion_hint = EMPHASIZE_HINT[lang](a.display_name);
    }

    return item;
  });
}

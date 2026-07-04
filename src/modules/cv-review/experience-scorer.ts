import { CanonicalCvDocument } from '../../common/types/canonical-cv';
import { BulletFeedbackItem } from './bullet-analyzer.service';
import { deriveCvSeniority } from '../../common/services/seniority';

/**
 * Routed-Evidence Dimension-3 (Experience, 0-20). Same pattern as Dim-1/Dim-2 (see
 * cv-review.service.ts routeDimension1/routeDimension2): a MECHANICAL fact — how many real
 * experience/project entries exist and how well their bullets are written — is scored
 * deterministically from the parsed document instead of trusting the LLM's own estimate.
 *
 * Returns `null` when the signal is too thin to score reliably (entries exist but almost no
 * bullets to judge quality from) — the caller keeps the LLM's own estimate in that case.
 */

/** Fixed score for a CV with literally no experience AND no project entries — a real, confident
 *  signal, not "we don't know" (hence not null). */
const ZERO_ENTRIES_SCORE = 2;
/** Below this many experience+projects bullets (with entries>0), quality can't be judged reliably. */
const MIN_BULLETS_FOR_SIGNAL = 2;

const QUANTITY_CAP = 12;
const POINTS_PER_EXPERIENCE_ENTRY = 3;
const POINTS_PER_PROJECT_ENTRY = 2;
const SENIORITY_BONUS = 2;

const QUANTIFIED_RATIO_BANDS = [
  { min: 0.5, points: 5 },
  { min: 0.25, points: 4 },
  { min: 0.1, points: 2 },
  { min: 0, points: 1 }, // >0, checked before the exact-zero fallback below
];
const VERB_FIRST_RATIO_BANDS = [
  { min: 0.6, points: 3 },
  { min: 0.3, points: 2 },
  { min: 0, points: 1 },
];

const HIGH_CONFIDENCE_MIN_ENTRIES = 2;
const HIGH_CONFIDENCE_MIN_BULLETS = 4;

export type ExperienceScoreConfidence = 'high' | 'medium' | 'low';

export interface ExperienceScoreResult {
  score20: number;
  confidence: ExperienceScoreConfidence;
  evidence: string[];
  rationale_vi: string;
  rationale_en: string;
}

function hasOrgAndRole(e: CanonicalCvDocument['experience'][number]): boolean {
  return Boolean(e.org?.trim()) && Boolean(e.role?.trim());
}

function hasTechOrBullets(p: CanonicalCvDocument['projects'][number]): boolean {
  return (p.tech?.length ?? 0) > 0 || (p.bullets?.length ?? 0) > 0;
}

/** Ratio → points via a descending band table; ratio===0 always scores 0 (the ">0" bands don't apply). */
function bandScore(ratio: number, bands: { min: number; points: number }[]): number {
  if (ratio <= 0) return 0;
  for (const b of bands) {
    if (ratio >= b.min) return b.points;
  }
  return 0;
}

export function scoreExperience(
  document: CanonicalCvDocument,
  bulletFeedback: BulletFeedbackItem[],
): ExperienceScoreResult | null {
  const expCount = document.experience?.length ?? 0;
  const projCount = document.projects?.length ?? 0;

  if (expCount === 0 && projCount === 0) {
    return {
      score20: ZERO_ENTRIES_SCORE,
      confidence: 'high',
      evidence: ['0 experience/project entries'],
      rationale_vi: 'CV chưa có mục kinh nghiệm hay dự án nào (0 experience/project entries).',
      rationale_en:
        'No experience or project entries found in the CV (0 experience/project entries).',
    };
  }

  const relevantBullets = bulletFeedback.filter(
    (b) => b.section === 'experience' || b.section === 'projects',
  );
  const totalBullets = relevantBullets.length;
  if (totalBullets < MIN_BULLETS_FOR_SIGNAL) return null; // too thin to judge quality — keep the LLM

  // ─── quantity (0-12) ──────────────────────────────────────────────────────
  const validExpEntries = (document.experience ?? []).filter(hasOrgAndRole).length;
  const validProjEntries = (document.projects ?? []).filter(hasTechOrBullets).length;
  const rawQuantity =
    validExpEntries * POINTS_PER_EXPERIENCE_ENTRY + validProjEntries * POINTS_PER_PROJECT_ENTRY;
  const seniority = deriveCvSeniority(document);
  const bonusEligible =
    seniority.est_years !== null && seniority.est_years >= 1 && seniority.confidence !== 'low';
  const quantity = Math.min(rawQuantity + (bonusEligible ? SENIORITY_BONUS : 0), QUANTITY_CAP);

  // ─── quality (0-8) — on experience+projects bullets ONLY ─────────────────
  const quantifiedCount = relevantBullets.filter((b) => b.quantified).length;
  const verbFirstCount = relevantBullets.filter((b) => b.verbFirst).length;
  const quantifiedRatio = quantifiedCount / totalBullets;
  const verbFirstRatio = verbFirstCount / totalBullets;
  const quality =
    bandScore(quantifiedRatio, QUANTIFIED_RATIO_BANDS) +
    bandScore(verbFirstRatio, VERB_FIRST_RATIO_BANDS);

  const totalEntries = expCount + projCount;
  const confidence: ExperienceScoreConfidence =
    totalEntries >= HIGH_CONFIDENCE_MIN_ENTRIES && totalBullets >= HIGH_CONFIDENCE_MIN_BULLETS
      ? 'high'
      : totalEntries === 1 ||
          (totalBullets >= MIN_BULLETS_FOR_SIGNAL && totalBullets < HIGH_CONFIDENCE_MIN_BULLETS)
        ? 'medium'
        : 'low';

  const evidence = [
    `${expCount} experience entries`,
    `${projCount} project entries`,
    ...(seniority.est_years !== null ? [`est_years=${seniority.est_years}`] : []),
    `quantified ${quantifiedCount}/${totalBullets} bullets`,
    `verb-first ${verbFirstCount}/${totalBullets} bullets`,
  ];

  return {
    score20: quantity + quality,
    confidence,
    evidence,
    rationale_vi:
      `${expCount} kinh nghiệm + ${projCount} dự án, ${quantifiedCount}/${totalBullets} bullet có số liệu, ` +
      `${verbFirstCount}/${totalBullets} bullet mở đầu bằng động từ mạnh (phân tích xác định).`,
    rationale_en:
      `${expCount} experience + ${projCount} project entries, ${quantifiedCount}/${totalBullets} bullets ` +
      `quantified, ${verbFirstCount}/${totalBullets} verb-first (deterministic analysis).`,
  };
}

import {
  CanonicalCvDocument,
  CvCertification,
  CvProjectEntry,
} from '../../common/types/canonical-cv';

export interface SelectedStoryItems {
  role_code?: string | null;
  projects?: CvProjectEntry[];
  certifications?: CvCertification[];
}
export interface MergeResult {
  doc: CanonicalCvDocument;
  applied: { projects: number; certifications: number };
  skipped_duplicates: Array<{ section: 'projects' | 'certifications'; name: string }>;
}

const norm = (s: string): string => (s ?? '').trim().toLowerCase();

/**
 * Deterministically merge user-chosen story items into a CV doc. Pure: clones the input (never mutates),
 * appends only non-empty, non-duplicate (by normalized name) projects/certs, and reports what it skipped.
 * `role_code` is intentionally NOT written here — the caller sends it as `targetRole` on the autosave PUT.
 */
export function mergeStoryItems(
  doc: CanonicalCvDocument,
  selected: SelectedStoryItems,
): MergeResult {
  const out: CanonicalCvDocument = JSON.parse(JSON.stringify(doc));
  out.projects ??= [];
  out.certifications ??= [];
  const skipped: MergeResult['skipped_duplicates'] = [];
  let appliedProjects = 0;
  let appliedCerts = 0;

  const projNames = new Set(out.projects.map((p) => norm(p.name)));
  for (const p of selected.projects ?? []) {
    const key = norm(p.name);
    if (!key) continue; // anti-empty
    if (projNames.has(key)) {
      skipped.push({ section: 'projects', name: p.name });
      continue;
    }
    projNames.add(key);
    out.projects.push(p);
    appliedProjects++;
  }

  const certNames = new Set(out.certifications.map((c) => norm(c.name)));
  for (const c of selected.certifications ?? []) {
    const key = norm(c.name);
    if (!key) continue;
    if (certNames.has(key)) {
      skipped.push({ section: 'certifications', name: c.name });
      continue;
    }
    certNames.add(key);
    out.certifications.push(c);
    appliedCerts++;
  }

  return {
    doc: out,
    applied: { projects: appliedProjects, certifications: appliedCerts },
    skipped_duplicates: skipped,
  };
}

import { classifyRole } from '../modules/jobs/ingest/ingest-normalizers';

export interface RoleBackfillChange {
  id: string;
  title: string;
  from: string | null;
  to: string;
}

/** Rule: change iff classifyRole(title) is non-null AND differs from the stored role_code. */
export function computeRoleBackfill(
  jobs: Array<{ id: string; title: string | null; role_code: string | null }>,
): RoleBackfillChange[] {
  const out: RoleBackfillChange[] = [];
  for (const j of jobs) {
    const next = classifyRole(j.title ?? '');
    if (next !== null && next !== j.role_code) {
      out.push({ id: j.id, title: j.title ?? '', from: j.role_code, to: next });
    }
  }
  return out;
}

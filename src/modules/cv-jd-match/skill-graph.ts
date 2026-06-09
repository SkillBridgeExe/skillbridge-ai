import * as fs from 'fs';
import * as path from 'path';

export type EdgeType = 'ecosystem' | 'adjacent' | 'tooling';

/** A curated skill→skill edge. `roles` lists the role canonicals where it holds, or ['*'] for any. */
export interface SkillEdge {
  from: string;
  to: string;
  type: EdgeType;
  confidence: number;
  roles: string[];
}

/** A display-only suggestion. The structured fields are the source of truth; `reason` is convenience copy. */
export interface InferredSkill {
  canonical_name: string;
  display_name: string;
  inferred_from: string;
  edge_type: EdgeType;
  confidence: number;
  reason: string;
}

export const MIN_CONFIDENCE = 0.5;
export const MAX_INFERRED = 5;

let _edgesCache: SkillEdge[] | null = null;
/** Loads the curated edge set once (mirrors RoleRubricService's loader). */
export function loadSkillEdges(): SkillEdge[] {
  if (_edgesCache) return _edgesCache;
  const filePath = path.join(process.cwd(), 'data', 'skill-graph-edges.json');
  _edgesCache = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SkillEdge[];
  return _edgesCache;
}

function reasonFor(type: EdgeType, from: string, to: string, lang: 'vi' | 'en'): string {
  if (lang === 'en') {
    if (type === 'adjacent') return `You have ${from}; ${to} is a comparable skill worth showing.`;
    if (type === 'tooling') return `You have ${from}; ${to} is a tool commonly used with it.`;
    return `You have ${from}; ${to} usually goes with this ecosystem — worth showcasing.`;
  }
  if (type === 'adjacent') return `Bạn có ${from}; ${to} là kỹ năng tương đương đáng thể hiện.`;
  if (type === 'tooling') return `Bạn có ${from}; ${to} là công cụ thường dùng kèm.`;
  return `Bạn có ${from}; ${to} thường đi cùng hệ sinh thái này — nên thể hiện.`;
}

/**
 * Pure, deterministic Inferred-layer inference. Given the CV's explicit canonicals + the target role,
 * suggest related ecosystem skills NOT already covered. Display-only — NEVER feeds the match score.
 * Guards (in order): role-gate · source-present · confidence-floor · not-already-covered · dedup · cap.
 */
export function inferSkills(
  edges: SkillEdge[],
  cvCanonicals: string[],
  targetRole: string | null,
  excludeCanonicals: Set<string>,
  resolveDisplay: (canonical: string) => string,
  lang: 'vi' | 'en' = 'vi',
): InferredSkill[] {
  const cvSet = new Set(cvCanonicals);
  const byTarget = new Map<string, InferredSkill>();
  for (const e of edges) {
    if (!e.roles.includes('*') && (targetRole === null || !e.roles.includes(targetRole))) continue; // 1
    if (!cvSet.has(e.from)) continue; // 2
    if (e.confidence < MIN_CONFIDENCE) continue; // 3
    if (excludeCanonicals.has(e.to)) continue; // 4
    const existing = byTarget.get(e.to); // 5
    if (existing && existing.confidence >= e.confidence) continue;
    byTarget.set(e.to, {
      canonical_name: e.to,
      display_name: resolveDisplay(e.to),
      inferred_from: e.from,
      edge_type: e.type,
      confidence: e.confidence,
      reason: reasonFor(e.type, resolveDisplay(e.from), resolveDisplay(e.to), lang),
    });
  }
  return [...byTarget.values()] // 6
    .sort((a, b) => b.confidence - a.confidence || a.canonical_name.localeCompare(b.canonical_name))
    .slice(0, MAX_INFERRED);
}

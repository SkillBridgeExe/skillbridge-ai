import * as fs from 'fs';
import * as path from 'path';

/**
 * Curated "child counts as parent" credit edge: having the child on the CV IS working
 * knowledge of the parent (sql_server ⇒ sql). Unlike skill-graph (display-only
 * suggestions), satisfies edges FEED THE SCORE — so every edge must be obviously true,
 * the set stays flat (no chaining), and an exact parent hit always wins (the caller
 * only consults this after an exact miss).
 */
export interface SatisfiesEdge {
  child: string;
  parent: string;
  note?: string;
}

let _cache: SatisfiesEdge[] | null = null;
/** Loads the curated satisfies set once (mirrors loadSkillEdges). */
export function loadSatisfiesEdges(): SatisfiesEdge[] {
  if (_cache) return _cache;
  const filePath = path.join(process.cwd(), 'data', 'skill-satisfies-edges.json');
  _cache = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SatisfiesEdge[];
  return _cache;
}

/**
 * Pure: the best CV skill satisfying `parent` via a curated edge, or null.
 * No chaining — exactly one child→parent hop.
 */
export function findSatisfying(
  parent: string,
  cvSkills: ReadonlyMap<string, { level: number }>,
  edges: SatisfiesEdge[],
): { child: string; level: number } | null {
  let best: { child: string; level: number } | null = null;
  for (const e of edges) {
    if (e.parent !== parent) continue;
    const hit = cvSkills.get(e.child);
    if (!hit) continue;
    if (!best || hit.level > best.level) best = { child: e.child, level: hit.level };
  }
  return best;
}

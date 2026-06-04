/**
 * Taxonomy validator — run before every taxonomy change ships (blueprint step 3 + risk list).
 *
 *   pnpm taxonomy:validate
 *
 * Enforces, with non-zero exit on violation:
 *   1. LICENSE: source ∈ {ESCO, ONET, CUSTOM}; SFIA/Lightcast/LinkedIn-derived rows are BANNED
 *      (paid/commercial-restricted licenses — see ATTRIBUTION.md).
 *   2. SCHEMA: required fields, snake_case canonical, unique canonicals.
 *   3. KEY SAFETY (normalizeKey replica): a canonical/display key colliding with ANY key of a
 *      different entry = HIJACK (canonical/display writes overwrite the index); an alias key
 *      owned by two different canonicals = silent first-writer-wins shadowing. Both are errors.
 *   4. RUBRIC INTEGRITY: every skill_canonical_name in role-rubrics-pilot.json still resolves.
 *   5. role_relevance role codes must be one of the 8 real roles.
 */
import * as fs from 'fs';
import * as path from 'path';

interface SkillEntry {
  canonical_name: string;
  display_name: string;
  category: string;
  source: string;
  source_external_id: string | null;
  aliases: string[];
  role_relevance?: Array<{ role: string; level: string }>;
  scoring_excluded?: boolean;
}

const ALLOWED_SOURCES = new Set(['ESCO', 'ONET', 'CUSTOM']);
const BANNED_SOURCES = new Set(['SFIA', 'LIGHTCAST', 'LINKEDIN']);
const VALID_ROLES = new Set([
  'frontend_developer',
  'backend_developer',
  'fullstack_developer',
  'mobile_developer',
  'data_analyst',
  'devops_engineer',
  'qa_tester',
  'ai_ml_engineer',
]);

/** Exact replica of SkillTaxonomyService.normalizeKey. */
const nk = (s: string): string =>
  s
    .toLowerCase()
    .trim()
    .replace(/[\s\-_./]+/g, '')
    .replace(/[()\[\]]/g, '');

function main(): void {
  const root = process.cwd();
  const { skills } = JSON.parse(
    fs.readFileSync(path.join(root, 'data', 'skills-pilot.json'), 'utf-8'),
  ) as { skills: SkillEntry[] };
  const { role_rubrics } = JSON.parse(
    fs.readFileSync(path.join(root, 'data', 'role-rubrics-pilot.json'), 'utf-8'),
  ) as { role_rubrics: Record<string, { skills: Array<{ skill_canonical_name: string }> }> };

  const errors: string[] = [];
  const warnings: string[] = [];

  // 1+2: license + schema + unique canonicals
  const canonicals = new Set<string>();
  for (const s of skills) {
    if (BANNED_SOURCES.has((s.source ?? '').toUpperCase()))
      errors.push(`BANNED LICENSE: ${s.canonical_name} has source=${s.source}`);
    else if (!ALLOWED_SOURCES.has(s.source))
      errors.push(
        `UNKNOWN SOURCE: ${s.canonical_name} source=${s.source} (allowed: ESCO|ONET|CUSTOM)`,
      );
    if (!/^[a-z0-9_]+$/.test(s.canonical_name))
      errors.push(`NOT snake_case: canonical '${s.canonical_name}'`);
    if (!s.display_name || !s.category) errors.push(`MISSING FIELDS on ${s.canonical_name}`);
    if (canonicals.has(s.canonical_name)) errors.push(`DUPLICATE canonical: ${s.canonical_name}`);
    canonicals.add(s.canonical_name);
    if ((s.aliases ?? []).length < 1) warnings.push(`no aliases: ${s.canonical_name}`);
    for (const r of s.role_relevance ?? [])
      if (!VALID_ROLES.has(r.role))
        errors.push(`INVALID role code '${r.role}' on ${s.canonical_name}`);
  }

  // 3: key safety
  const keyOwner = new Map<string, { owner: string; kind: string }>();
  for (const s of skills) {
    const claims: Array<{ key: string; kind: 'canonical' | 'display' | 'alias' }> = [
      { key: nk(s.canonical_name), kind: 'canonical' },
      { key: nk(s.display_name), kind: 'display' },
      ...(s.aliases ?? []).map((a) => ({ key: nk(a), kind: 'alias' as const })),
    ];
    const within = new Set<string>();
    for (const c of claims) {
      if (within.has(c.key)) continue; // intra-entry dup → harmless, skip silently
      within.add(c.key);
      const prev = keyOwner.get(c.key);
      if (!prev) {
        keyOwner.set(c.key, { owner: s.canonical_name, kind: c.kind });
      } else if (prev.owner !== s.canonical_name) {
        if (c.kind === 'alias' && prev.kind === 'alias')
          errors.push(
            `ALIAS SHADOWING: key '${c.key}' owned by ${prev.owner}, re-claimed by ${s.canonical_name} (first-writer-wins hides this)`,
          );
        else
          errors.push(
            `KEY HIJACK: '${c.key}' (${c.kind} of ${s.canonical_name}) collides with ${prev.kind} of ${prev.owner}`,
          );
      }
    }
  }

  // 4: rubric integrity
  for (const [role, rubric] of Object.entries(role_rubrics)) {
    for (const req of rubric.skills) {
      if (!canonicals.has(req.skill_canonical_name))
        errors.push(
          `RUBRIC BROKEN: ${role} references missing skill '${req.skill_canonical_name}'`,
        );
    }
  }

  console.log(`\nTaxonomy validation — ${skills.length} skills, ${keyOwner.size} index keys`);
  if (warnings.length) console.log(`\nWarnings (${warnings.length}):\n  ${warnings.join('\n  ')}`);
  if (errors.length) {
    console.log(`\nERRORS (${errors.length}):\n  ${errors.join('\n  ')}`);
    console.log('\nVerdict: FAIL ❌\n');
    process.exit(1);
  }
  console.log('\nVerdict: PASS ✅\n');
}

main();

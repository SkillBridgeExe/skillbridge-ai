/**
 * Task 7 (Phase 1b) — build the ESCO role→skill REFERENCE graph.
 *   pnpm exec ts-node -r tsconfig-paths/register src/tools/build-esco-role-skill.ts
 *
 * For ESCO's ICT occupations (ISCO unit groups 25xx), aggregate each occupation's
 * essential/optional skills, normalize the skill label to OUR canonical taxonomy
 * (SkillNormalizerService), and group by OUR 8 role codes via an occupation-keyword map.
 *
 * Emits data/esco/esco-role-skill.json — a REFERENCE artifact ONLY. It is deliberately
 * NOT merged into skills-pilot.json `role_relevance` and NOT fed to SkillDiff scoring:
 *   - the ISCO/occupation→our-role mapping is approximate (no clean ESCO peer for
 *     qa/mobile/ai_ml), so auto-merging would pollute the 46 hand-curated role_relevance rows;
 *   - widening the scoring surface is the X1 under-scoring trap.
 * Use it to INFORM future, eval-gated rubric expansion / trends — not as ground truth.
 */
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { SkillNormalizerService } from '../common/services/skill-normalizer.service';

// occupation preferredLabel (lowercased) → our role code. First match wins; order = priority.
const OCC_TO_ROLE: Array<[RegExp, string]> = [
  [/full.?stack/, 'fullstack_developer'],
  [/tester|test analyst|test engineer|quality assurance|accessibility tester/, 'qa_tester'],
  [
    /data scientist|machine learning|computer vision|artificial intelligence|deep learning/,
    'ai_ml_engineer',
  ],
  [/mobile application|mobile devices software/, 'mobile_developer'],
  [
    /data engineer|data analyst|data warehouse|database|data mining|business intelligence/,
    'data_analyst',
  ],
  [
    /network|system administrator|system configurator|cloud|capacity planner|devops|site reliability|infrastructure/,
    'devops_engineer',
  ],
  [
    /web developer|user interface|front.?end|web content|search engine optimisation|games developer/,
    'frontend_developer',
  ],
  [
    /software developer|software analyst|application developer|application configurator|back.?end|blockchain developer|embedded/,
    'backend_developer',
  ],
];

function roleFor(label: string): string | null {
  const l = label.toLowerCase();
  for (const [re, role] of OCC_TO_ROLE) if (re.test(l)) return role;
  return null; // security/forensics/etc. — no peer among our 8 roles
}

async function main(): Promise<void> {
  const dir = path.join(process.cwd(), 'data', 'esco');
  const opts = { columns: true, bom: true, relax_quotes: true, skip_empty_lines: true } as const;
  const occ = parse(fs.readFileSync(path.join(dir, 'occupations_en.csv')), opts) as Record<
    string,
    string
  >[];
  const rel = parse(
    fs.readFileSync(path.join(dir, 'occupationSkillRelations_en.csv')),
    opts,
  ) as Record<string, string>[];

  // occupationUri → our role (only ISCO 25xx occupations we can map).
  const occRole = new Map<string, string>();
  let mappedOcc = 0;
  for (const o of occ) {
    if (!String(o.iscoGroup ?? '').startsWith('25')) continue;
    const role = roleFor(o.preferredLabel ?? '');
    if (role) {
      occRole.set(o.conceptUri, role);
      mappedOcc++;
    }
  }

  process.env.NODE_ENV = 'test';
  const ctx = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const normalizer = ctx.get(SkillNormalizerService, { strict: false });

  // role → canonical → { essential occ count, optional occ count }
  const agg = new Map<string, Map<string, { essential: number; optional: number }>>();
  const cache = new Map<string, string | null>(); // skillLabel → our canonical (or null)
  let relRows = 0;

  for (const r of rel) {
    const role = occRole.get(r.occupationUri);
    if (!role) continue;
    relRows++;
    const label = r.skillLabel ?? '';
    let canonical = cache.get(label);
    if (canonical === undefined) {
      const out = normalizer.normalizeMany([label]);
      const m = out.find((x) => x.matched_via !== 'none' && x.canonical_name);
      canonical = m ? (m.canonical_name as string) : null;
      cache.set(label, canonical);
    }
    if (!canonical) continue; // skill not in OUR taxonomy → out of scope for the reference
    if (!agg.has(role)) agg.set(role, new Map());
    const m = agg.get(role)!;
    if (!m.has(canonical)) m.set(canonical, { essential: 0, optional: 0 });
    const c = m.get(canonical)!;
    if ((r.relationType ?? '') === 'essential') c.essential++;
    else c.optional++;
  }

  // serialize, sorted by essential desc then canonical.
  const out: Record<string, Array<{ skill: string; essential: number; optional: number }>> = {};
  for (const [role, m] of agg) {
    out[role] = [...m.entries()]
      .map(([skill, c]) => ({ skill, essential: c.essential, optional: c.optional }))
      .sort((a, b) => b.essential - a.essential || a.skill.localeCompare(b.skill));
  }

  const payload = {
    _note:
      'ESCO ICT-occupation (ISCO 25xx) → our-role REFERENCE only. Approximate occupation→role mapping; ' +
      'NOT merged into skills-pilot.json role_relevance and NOT used in SkillDiff scoring (X1-safe). ' +
      'Use to inform eval-gated rubric expansion / trends.',
    source: 'ESCO v1.2.x occupationSkillRelations (CC BY 4.0)',
    mapped_occupations: mappedOcc,
    relation_rows_considered: relRows,
    distinct_skill_labels: cache.size,
    roles: out,
  };
  fs.writeFileSync(path.join(dir, 'esco-role-skill.json'), JSON.stringify(payload, null, 2) + '\n');

  console.log(`mapped ISCO-25 occupations: ${mappedOcc} | relation rows: ${relRows}`);
  for (const role of Object.keys(out).sort())
    console.log(
      `  ${role.padEnd(22)} ${out[role].length} of-our-taxonomy skills (top: ${out[role]
        .slice(0, 6)
        .map((s) => s.skill)
        .join(', ')})`,
    );
  await ctx.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

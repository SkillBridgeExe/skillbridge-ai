/**
 * CV-Patch eval (eval:patch) — OFFLINE, 0-LLM end-to-end check of the PR4 patch plan through the
 * REAL SkillNormalizer → SkillDiffService → buildGapItems + buildTailorChecklist → decorateWithPatch.
 * Mirrors eval:gap. The CI gate is the jest cv-patch.spec.ts; this is the human-readable report +
 * a full-pipeline (real taxonomy) check that the honesty contract holds end to end.
 *
 *   pnpm eval:patch
 *
 * Asserts per case (expect_patch[]): action_type, rewrite_eligible, and has_before — proving a
 * `before` appears ONLY for an evidence-backed rewrite whose anchor resolves to a real CV bullet.
 */
import * as fs from 'fs';
import * as path from 'path';
import { SkillTaxonomyService } from '../common/services/skill-taxonomy.service';
import { SkillNormalizerService } from '../common/services/skill-normalizer.service';
import { RoleRubricService } from '../common/services/role-rubric.service';
import {
  SkillDiffService,
  RawCvSkill,
  DiffResult,
} from '../modules/cv-jd-match/skill-diff.service';
import { CvJdMatchParsedResponse } from '../modules/cv-jd-match/dto/cv-jd-match-response.dto';
import { EvidenceLedger } from '../common/services/evidence-ledger';
import { CanonicalCvDocument } from '../common/types/canonical-cv';
import { buildGapItems } from '../modules/gap-engine/gap-item';
import { buildTailorChecklist } from '../modules/cv-jd-match/tailor-checklist';
import { decorateWithPatch } from '../modules/cv-jd-match/cv-patch';

interface PatchCase {
  id: string;
  target_role: string;
  cv_skills: Array<{ name: string; proficiency_hint: string }>;
  jd_requirements?: Array<{ name: string; importance_hint?: string; required_level_hint?: string }>;
  ledger_listed_only?: string[];
  /** [canonical, project_ref] — a demonstrated skill anchored to a project name in cv_projects. */
  ledger_demonstrated?: Array<[string, string]>;
  cv_projects?: Array<{ name: string; bullets: string[] }>;
  expect_patch: Array<{
    canonical: string;
    action_type: string;
    rewrite_eligible: boolean;
    has_before: boolean;
  }>;
}

function buildLedger(c: PatchCase): EvidenceLedger | null {
  const listed = c.ledger_listed_only ?? [];
  const demo = c.ledger_demonstrated ?? [];
  if (!listed.length && !demo.length) return null;
  return {
    evidence_gap: [...listed],
    items: [
      ...listed.map((s) => ({
        skill_canonical: s,
        display_name: s,
        sources: [],
        strength: 'listed_only' as const,
        most_recent_year: null,
      })),
      ...demo.map(([s, ref]) => ({
        skill_canonical: s,
        display_name: s,
        sources: [{ kind: 'project' as const, ref, recency_year: 2025 }],
        strength: 'demonstrated' as const,
        most_recent_year: 2025,
      })),
    ],
  };
}

function buildDoc(c: PatchCase): CanonicalCvDocument | null {
  if (!c.cv_projects?.length) return null;
  return {
    language: 'vi',
    contact: { name: null, email: null, phone: null, location: null, links: [] },
    summary: '',
    education: [],
    experience: [],
    projects: c.cv_projects.map((p) => ({
      name: p.name,
      role: null,
      tech: [],
      bullets: p.bullets,
      link: null,
    })),
    skills: { technical: [], soft: [], languages: [], tools: [] },
    certifications: [],
    activities: [],
  };
}

async function main(): Promise<void> {
  const file = path.join(process.cwd(), 'data', 'eval-patch-cases.json');
  const { cases } = JSON.parse(fs.readFileSync(file, 'utf-8')) as { cases: PatchCase[] };

  const taxonomy = new SkillTaxonomyService();
  await taxonomy.onModuleInit();
  const normalizer = new SkillNormalizerService(taxonomy);
  const rubrics = new RoleRubricService();
  await rubrics.onModuleInit();
  const diffSvc = new SkillDiffService(normalizer, rubrics);

  console.log(`\nCV-Patch eval — ${cases.length} cases (offline, 0 LLM calls)\n`);
  const dataErrors: string[] = [];
  const misses: string[] = [];

  for (const c of cases) {
    const res: DiffResult = diffSvc.diff({
      cv_skills_raw: c.cv_skills as RawCvSkill[],
      target_role: c.target_role,
      ...(c.jd_requirements ? { jd_requirements_raw: c.jd_requirements } : {}),
    });
    if (res.unnormalized_cv_skills.length > 0) {
      dataErrors.push(
        `  ${c.id}: unnormalized cv_skills [${res.unnormalized_cv_skills.map((u) => u.raw_input).join(', ')}]`,
      );
    }

    const match = {
      matched_skills: res.matched_skills,
      partial_skills: res.partial_skills,
      missing_skills: res.missing_skills,
      keyword_frequency: [],
      source_of_requirements: res.requirements_source,
      target_role: c.target_role,
    } as unknown as CvJdMatchParsedResponse;

    const ledger = buildLedger(c);
    const items = decorateWithPatch({
      actions: buildTailorChecklist(match, ledger, 'vi'),
      gapItems: buildGapItems({ match, ledger }),
      document: buildDoc(c),
      lang: 'vi',
    });
    const byCanon = new Map(items.map((i) => [i.skill_canonical, i]));

    const lines: string[] = [];
    for (const e of c.expect_patch) {
      const it = byCanon.get(e.canonical);
      if (!it) {
        misses.push(`  ${c.id}: expected patch "${e.canonical}" not produced`);
        continue;
      }
      if (it.action_type !== e.action_type)
        misses.push(
          `  ${c.id}: ${e.canonical}.action_type="${it.action_type}", expected "${e.action_type}"`,
        );
      if (it.rewrite_eligible !== e.rewrite_eligible)
        misses.push(
          `  ${c.id}: ${e.canonical}.rewrite_eligible=${it.rewrite_eligible}, expected ${e.rewrite_eligible}`,
        );
      const hasBefore = it.before !== null;
      if (hasBefore !== e.has_before)
        misses.push(`  ${c.id}: ${e.canonical}.has_before=${hasBefore}, expected ${e.has_before}`);
      lines.push(`${e.canonical}=${it.action_type}/rw:${it.rewrite_eligible}/before:${hasBefore}`);
    }
    console.log(`${c.id.padEnd(40)} ${lines.join('  ')}`);
  }

  console.log('\n=== Summary ===');
  if (dataErrors.length)
    console.log(`DATA ERRORS (corrupt measurement):\n${dataErrors.join('\n')}`);
  if (misses.length) console.log(`Expectation misses:\n${misses.join('\n')}`);
  const fail = dataErrors.length > 0 || misses.length > 0;
  console.log(`\nVerdict: ${fail ? 'FAIL ❌' : 'PASS ✅'}\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('\neval-patch failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});

/**
 * Anti-inflate calibration gate. Fully OFFLINE (no LLM, no DB). Locks the deterministic proficiency
 * invariants so they cannot silently drift:
 *   (i)   qualifierToProficiency maps each EN/VN qualifier word as expected (incl. null when absent).
 *   (ii)  capForEvidence never yields ADVANCED/EXPERT for listed_only/mentioned evidence.
 *   (iii) the EXISTING skill-diff default holds: a JD requirement with missing/invalid level coerces
 *         to INTERMEDIATE (level 3) + importance REQUIRED — exercised via a real diff() (no privates).
 *   (iv)  table parity: PROFICIENCY_TO_LEVEL is strictly monotonic AND the level skill-diff produces
 *         for each proficiency_hint equals PROFICIENCY_TO_LEVEL[hint] (locks the verbatim relocation).
 *
 *   pnpm eval:proficiency                         # report + gate
 *   EVAL_PROFICIENCY_STRICT=1 pnpm eval:proficiency  # symmetry with the other harnesses
 *
 * Families (i)-(iv) are INVARIANTS (always fatal). capForEvidence here is gate/telemetry use ONLY —
 * it is NOT wired into skill-diff scoring (see proficiency-calibration.ts header).
 */
import * as fs from 'fs';
import * as path from 'path';
import { SkillTaxonomyService } from '../common/services/skill-taxonomy.service';
import { SkillNormalizerService } from '../common/services/skill-normalizer.service';
import { RoleRubricService } from '../common/services/role-rubric.service';
import { SkillDiffService, DiffResult } from '../modules/cv-jd-match/skill-diff.service';
import {
  Proficiency,
  PROFICIENCY_TO_LEVEL,
  qualifierToProficiency,
  capForEvidence,
} from '../common/services/proficiency-calibration';

interface Cases {
  qualifier_cases: Array<{ text: string; expected: Proficiency | null }>;
  evidence_cap_cases: Array<{
    prof: Proficiency;
    evidence: 'demonstrated' | 'listed_only' | 'mentioned';
    expected: Proficiency;
  }>;
  jd_default_cases: Array<{
    required_level_hint: string | null;
    importance_hint: string | null;
    expected_level: number;
    expected_importance: string;
  }>;
}

const STRICT = process.env.EVAL_PROFICIENCY_STRICT === '1';
const PROFS: Proficiency[] = ['BEGINNER', 'NOVICE', 'INTERMEDIATE', 'ADVANCED', 'EXPERT'];

async function main(): Promise<void> {
  const file = path.join(process.cwd(), 'data', 'eval-proficiency-cases.json');
  const cases = JSON.parse(fs.readFileSync(file, 'utf-8')) as Cases;

  const taxonomy = new SkillTaxonomyService();
  await taxonomy.onModuleInit();
  const normalizer = new SkillNormalizerService(taxonomy);
  const rubrics = new RoleRubricService();
  await rubrics.onModuleInit();
  const diffSvc = new SkillDiffService(normalizer, rubrics);

  const fails: string[] = [];

  // (i) qualifier mapping
  for (const c of cases.qualifier_cases) {
    const got = qualifierToProficiency(c.text);
    if (got !== c.expected)
      fails.push(`(i) qualifier "${c.text}" → ${got}, expected ${c.expected}`);
  }

  // (ii) evidence cap — fixture cases + blanket invariant
  for (const c of cases.evidence_cap_cases) {
    const got = capForEvidence(c.prof, c.evidence);
    if (got !== c.expected)
      fails.push(`(ii) cap ${c.prof}/${c.evidence} → ${got}, expected ${c.expected}`);
  }
  for (const p of PROFS) {
    for (const ev of ['listed_only', 'mentioned'] as const) {
      if (PROFICIENCY_TO_LEVEL[capForEvidence(p, ev)] > PROFICIENCY_TO_LEVEL.INTERMEDIATE) {
        fails.push(`(ii) INVARIANT: ${p}/${ev} caps above INTERMEDIATE`);
      }
    }
  }

  // (iii) JD default-3 / REQUIRED via a real diff (JD path; rubric not merged when JD given)
  for (const c of cases.jd_default_cases) {
    const req: { name: string; required_level_hint?: string; importance_hint?: string } = {
      name: 'react',
    };
    if (c.required_level_hint !== null) req.required_level_hint = c.required_level_hint;
    if (c.importance_hint !== null) req.importance_hint = c.importance_hint;
    const res: DiffResult = diffSvc.diff({
      cv_skills_raw: [],
      jd_requirements_raw: [req],
      target_role: null,
    });
    const react = [...res.missing_skills, ...res.matched_skills, ...res.partial_skills].find(
      (s) => s.canonical_name === 'react',
    );
    if (!react) {
      fails.push(`(iii) react requirement not produced for hint=${c.required_level_hint}`);
    } else {
      if (react.required_level !== c.expected_level)
        fails.push(
          `(iii) required_level ${react.required_level} != ${c.expected_level} (hint=${c.required_level_hint})`,
        );
      if (react.importance !== c.expected_importance)
        fails.push(
          `(iii) importance ${react.importance} != ${c.expected_importance} (hint=${c.importance_hint})`,
        );
    }
  }

  // (iv) table parity — monotonic + per-hint cv_level equals PROFICIENCY_TO_LEVEL[hint]
  const lv = PROFS.map((p) => PROFICIENCY_TO_LEVEL[p]);
  if (JSON.stringify(lv) !== JSON.stringify([1, 2, 3, 4, 5]))
    fails.push(`(iv) PROFICIENCY_TO_LEVEL not strictly monotonic: ${lv.join(',')}`);
  for (const p of PROFS) {
    const res = diffSvc.diff({
      cv_skills_raw: [{ name: 'react', proficiency_hint: p }],
      jd_requirements_raw: [{ name: 'react' }],
      target_role: null,
    });
    const react = [...res.matched_skills, ...res.partial_skills].find(
      (s) => s.canonical_name === 'react',
    );
    if (!react) fails.push(`(iv) react not in matched/partial for hint ${p}`);
    else if (react.cv_level !== PROFICIENCY_TO_LEVEL[p])
      fails.push(
        `(iv) hint ${p} → cv_level ${react.cv_level}, expected ${PROFICIENCY_TO_LEVEL[p]}`,
      );
  }

  console.log(
    `\nProficiency calibration eval — ${cases.qualifier_cases.length} qualifier / ${cases.evidence_cap_cases.length} cap / ${cases.jd_default_cases.length} jd-default cases + invariants (offline, 0 LLM)\n`,
  );
  if (fails.length) console.log(`FAILURES:\n${fails.map((f) => `  ${f}`).join('\n')}`);
  else console.log('All calibration invariants hold.');

  const fail = fails.length > 0;
  console.log(`\nVerdict: ${fail ? 'FAIL ❌' : 'PASS ✅'}${STRICT ? ' [strict]' : ''}\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('\neval-proficiency failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});

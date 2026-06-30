/**
 * Role-inference eval — the GATE for Story→CV slice 1. Fully OFFLINE (no LLM, no DB): each gold story
 * runs through the REAL SkillTaxonomy alias index → weighted role inference over the REAL 9-role
 * rubric. Reports accuracy + abstention-accuracy + a confusion matrix (reusing calibration-metrics),
 * and exits non-zero below baseline so a regression fails CI.
 *
 *   npm run eval:role-infer
 *
 * Gold set (data/eval-role-infer-cases.json) is the USER's lane — expand to 20-30 labeled stories.
 * expected_role: null = a case that SHOULD abstain (too weak / ambiguous → needs_user_input).
 */
import * as fs from 'fs';
import * as path from 'path';
import { SkillTaxonomyService } from '../common/services/skill-taxonomy.service';
import { RoleRubricService } from '../common/services/role-rubric.service';
import { confusionMatrix } from './calibration-metrics';
import { inferRoleFromStory, rubricsToProfiles } from '../modules/cv-builder/role-inference';

const BASELINE_ACC = 0.7; // floor; raise as the gold set matures.
const NONE = '__none__'; // confusion-matrix label for "abstained / no role".

interface RoleCase {
  id: string;
  story: string;
  expected_role: string | null;
}

async function main(): Promise<void> {
  // Lightweight bootstrap (mirrors eval-gap.ts) — instantiate the services directly, no Nest context.
  const taxonomy = new SkillTaxonomyService();
  await taxonomy.onModuleInit();
  const rubrics = new RoleRubricService();
  await rubrics.onModuleInit();

  const profiles = rubricsToProfiles(rubrics.listRubrics());
  // resolve = taxonomy alias lookup, composed from the two existing public methods (no new method).
  const resolve = (raw: string): string | null =>
    taxonomy.lookupByAliasKey(SkillTaxonomyService.normalizeKey(raw)) ?? null;

  const { cases } = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'data', 'eval-role-infer-cases.json'), 'utf-8'),
  ) as { cases: RoleCase[] };

  const expected: string[] = [];
  const predicted: string[] = [];
  let abstainTotal = 0;
  let abstainOk = 0;

  for (const c of cases) {
    const out = inferRoleFromStory(c.story, resolve, profiles);
    const got = out.role_code ?? NONE;
    const exp = c.expected_role ?? NONE;
    expected.push(exp);
    predicted.push(got);
    if (exp === NONE) {
      abstainTotal++;
      if (out.needs_user_input) abstainOk++;
    }
    if (got !== exp) {
      // Show the top-2 candidates (even on abstain) so a MISS is diagnosable — this is the input to
      // the threshold-calibration step (minConfidence / ambiguityMargin).
      const c0 = out.candidates[0];
      const c1 = out.candidates[1];
      const fmt = (x?: { role_code: string; score: number; matched: string[] }) =>
        x ? `${x.role_code} ${x.score.toFixed(2)} (${x.matched.join(',')})` : '—';
      console.log(
        `MISS ${c.id}: expected=${exp} got=${got} reason=${out.reason} | top=[${fmt(c0)}] 2nd=[${fmt(c1)}]`,
      );
    }
  }

  const correct = expected.filter((e, i) => e === predicted[i]).length;
  const acc = cases.length ? correct / cases.length : 0;

  const labels = [...new Set([...expected, ...predicted])].sort();
  const matrix = confusionMatrix(predicted, expected, labels); // rows = actual, cols = predicted

  console.log(`\nrole-infer accuracy = ${(acc * 100).toFixed(1)}% (${correct}/${cases.length})`);
  if (abstainTotal) {
    console.log(
      `abstention correct = ${abstainOk}/${abstainTotal} (abstained when the story is weak/ambiguous)`,
    );
  }
  console.log('labels:', labels.join(', '));
  console.log('confusion (rows=actual, cols=predicted):', JSON.stringify(matrix));

  if (acc < BASELINE_ACC) {
    console.error(`\nBELOW BASELINE ${BASELINE_ACC} — failing.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

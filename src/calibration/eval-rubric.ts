/**
 * Offline rubric calibration gate.
 *
 *   pnpm eval:rubric
 *
 * This does not call the LLM and does not touch the DB. It feeds synthetic no-JD
 * student/fresher profiles through the real SkillNormalizer → RoleRubric → SkillDiff stack.
 */
import * as fs from 'fs';
import * as path from 'path';
import { SkillTaxonomyService } from '../common/services/skill-taxonomy.service';
import { SkillNormalizerService } from '../common/services/skill-normalizer.service';
import { RoleRubricService } from '../common/services/role-rubric.service';
import { SkillDiffService } from '../modules/cv-jd-match/skill-diff.service';
import {
  evaluateRubricCaseResult,
  RubricCalibrationCase,
  summarizeRubricCalibration,
  validateRubricStructure,
} from './rubric-calibration';

async function main(): Promise<void> {
  const file = path.join(process.cwd(), 'data', 'eval-rubric-calibration.json');
  const { cases } = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
    cases: RubricCalibrationCase[];
  };

  const taxonomy = new SkillTaxonomyService();
  await taxonomy.onModuleInit();
  const normalizer = new SkillNormalizerService(taxonomy);
  const rubrics = new RoleRubricService();
  await rubrics.onModuleInit();
  const diffSvc = new SkillDiffService(normalizer, rubrics);

  const structuralErrors = validateRubricStructure(
    rubrics.listRubrics(),
    (canonical) => taxonomy.getByCanonical(canonical) !== undefined,
    [...new Set(cases.map((testCase) => testCase.target_role))],
  );

  const results = cases.map((testCase) => {
    const diff = diffSvc.diff({
      cv_skills_raw: testCase.cv_skills,
      target_role: testCase.target_role,
      target_band: testCase.target_band,
    });
    return evaluateRubricCaseResult(testCase, diff);
  });

  console.log(
    `\nRubric calibration eval — ${results.length} no-JD role/band cases (offline, 0 LLM)\n`,
  );
  for (const result of results) {
    const coverage = result.requiredCoverage === undefined ? 'n/a' : result.requiredCoverage;
    console.log(
      `${result.id.padEnd(34)} role=${result.role.padEnd(20)} band=${result.band.padEnd(7)} ` +
        `score=${String(result.score).padStart(3)} expected=${result.expected[0]}-${result.expected[1]} ` +
        `coverage=${coverage} m/p/m=${result.matched}/${result.partial}/${result.missing} ` +
        `${result.pass ? 'OK' : 'OUT'}`,
    );
    for (const error of result.errors) {
      console.log(`  - ${error}`);
    }
  }

  const summary = summarizeRubricCalibration(results, structuralErrors);
  console.log('\n=== Role Coverage ===');
  for (const [role, item] of Object.entries(summary.byRole).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    console.log(`${role.padEnd(20)} total=${item.total} pass=${item.passed} fail=${item.failed}`);
  }

  if (structuralErrors.length > 0) {
    console.log(
      `\nStructural errors:\n${structuralErrors.map((error) => `  ${error}`).join('\n')}`,
    );
  }
  if (summary.failed.length > 0) {
    console.log(`\nOut-of-band cases:\n${summary.failed.map((id) => `  ${id}`).join('\n')}`);
  }

  console.log(
    `\nVerdict: ${summary.pass ? 'PASS ✅' : 'FAIL ❌'} (${summary.passed}/${summary.total} cases)\n`,
  );
  process.exit(summary.pass ? 0 : 1);
}

main().catch((err) => {
  console.error('\neval-rubric failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});

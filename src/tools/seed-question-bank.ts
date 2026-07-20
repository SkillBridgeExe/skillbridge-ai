/**
 * Scoped seeder: interview question bank ONLY (insert-missing, idempotent).
 *
 * Unlike `pnpm seed`, this touches NOTHING else — no demo admin/user accounts, no mentor
 * profiles, no roles/skills. Safe to run deliberately against prod to publish newly authored
 * bank questions (e.g. the P2 hand-authored scenario layer):
 *
 *   # PowerShell, deliberate prod op (prod-db-guard requires the explicit flag):
 *   $env:ALLOW_PROD_DB = "1"; pnpm seed:question-bank; Remove-Item Env:ALLOW_PROD_DB
 *
 * Local/dev: plain `pnpm seed:question-bank`.
 */
import dataSource from '../database/data-source';
import { InterviewQuestionBankItemEntity } from '../database/entities/interview-question-bank-item.entity';
import { seedInterviewQuestionBank } from '../database/seed';

async function main(): Promise<void> {
  await dataSource.initialize();
  try {
    const repo = dataSource.getRepository(InterviewQuestionBankItemEntity);
    const before = await repo.count();
    await seedInterviewQuestionBank(repo);
    const after = await repo.count();
    console.log(
      `interview question bank: ${after} rows total (${after - before} inserted, existing rows untouched).`,
    );
  } finally {
    await dataSource.destroy();
  }
}

main().catch((err) => {
  console.error(`seed-question-bank failed: ${(err as Error).message}`);
  process.exit(1);
});

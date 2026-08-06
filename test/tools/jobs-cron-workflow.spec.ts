import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('jobs-pool-refresh workflow', () => {
  const workflow = readFileSync(
    join(process.cwd(), '.github', 'workflows', 'jobs-cron.yml'),
    'utf8',
  );

  it('explicitly opts deliberate scheduler jobs into production DB access', () => {
    const workflowEnv = workflow.slice(0, workflow.indexOf('\njobs:'));

    expect(workflowEnv).toContain("ALLOW_PROD_DB: '1'");
  });

  it.each(['pnpm jobs:crawl 200', 'pnpm trends:refresh', 'pnpm business-jobs:maintenance'])(
    'keeps the scheduled command %s',
    (command) => {
      expect(workflow).toContain(command);
    },
  );
});

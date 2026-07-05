import { QueryRunner } from 'typeorm';
import { ImpactCalibrations1781070000000 } from '../../../src/database/migrations/1781070000000-ImpactCalibrations';

describe('ImpactCalibrations1781070000000', () => {
  it('creates impact_calibrations with a nullable user FK, the idempotency unique, and the user/created index', async () => {
    const sql = (await collectQueries((m) => m.up.bind(m))).join('\n');

    expect(sql).toContain('"user_id" uuid');
    expect(sql).toContain('FK_impact_calibrations_user_id');
    expect(sql).toContain('FOREIGN KEY ("user_id") REFERENCES "users"("id")');
    expect(sql).toContain('ON DELETE SET NULL');
    expect(sql).toContain('UQ_impact_calibrations_prior_current_canonical');
    expect(sql).toContain('UNIQUE ("prior_match_id", "current_match_id", "canonical_name")');
    expect(sql).toContain('IDX_impact_calibrations_user_created');
    expect(sql).toContain('("user_id", "created_at")');
    expect(sql).toContain('"predicted_severity_drop" numeric(6,3)');
    expect(sql).not.toMatch(/"predicted_severity_drop" numeric\(6,3\) NOT NULL/);
  });

  it('drops the FK before dropping the table', async () => {
    const sql = (await collectQueries((m) => m.down.bind(m))).join('\n');

    expect(sql).toContain('DROP CONSTRAINT IF EXISTS "FK_impact_calibrations_user_id"');
    expect(sql.indexOf('DROP CONSTRAINT')).toBeLessThan(sql.indexOf('DROP TABLE'));
  });
});

async function collectQueries(
  pick: (m: ImpactCalibrations1781070000000) => (qr: QueryRunner) => Promise<void>,
): Promise<string[]> {
  const queries: string[] = [];
  const queryRunner = {
    query: jest.fn(async (sql: string) => {
      queries.push(sql);
    }),
  } as unknown as QueryRunner;

  await pick(new ImpactCalibrations1781070000000())(queryRunner);

  return queries;
}

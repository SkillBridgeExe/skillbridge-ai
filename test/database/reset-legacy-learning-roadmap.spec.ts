import type { QueryRunner } from 'typeorm';
import {
  assertSafeResetEnvironment,
  PRODUCTION_RESET_CONFIRMATION,
  resetLegacyLearningRoadmap,
} from '../../src/tools/reset-legacy-learning-roadmap';

const LEGACY_COLUMNS = [
  'id',
  'user_id',
  'active',
  'source_refs',
  'composed_roadmap',
  'schedule',
  'created_at',
  'updated_at',
];

function runnerWith(queryResults: unknown[]): QueryRunner {
  return {
    query: jest.fn().mockImplementation(() => Promise.resolve(queryResults.shift())),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
  } as unknown as QueryRunner;
}

describe('resetLegacyLearningRoadmap', () => {
  it.each([
    { NODE_ENV: 'production' },
    { NODE_ENV: 'development', K_SERVICE: 'learning-api' },
    { NODE_ENV: 'development', ALLOW_PROD_DB: '1' },
  ])('refuses production or production-override environments: %p', (environment) => {
    expect(() => assertSafeResetEnvironment(environment)).toThrow(
      'forbidden in production or override mode',
    );
  });

  it('accepts an explicitly configured development database environment', () => {
    expect(() =>
      assertSafeResetEnvironment({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgresql://localhost/skillbridge_dev',
      }),
    ).not.toThrow();
  });

  it('allows the read-only inspection command in production', () => {
    expect(() =>
      assertSafeResetEnvironment({ NODE_ENV: 'production', ALLOW_PROD_DB: '1' }, true),
    ).not.toThrow();
  });

  it('allows a production reset only with the exact one-time confirmation', () => {
    expect(() =>
      assertSafeResetEnvironment({
        NODE_ENV: 'production',
        CONFIRM_LEGACY_LEARNING_ROADMAP_RESET: PRODUCTION_RESET_CONFIRMATION,
      }),
    ).not.toThrow();
    expect(() =>
      assertSafeResetEnvironment({
        NODE_ENV: 'production',
        CONFIRM_LEGACY_LEARNING_ROADMAP_RESET: 'wrong-confirmation',
      }),
    ).toThrow('forbidden in production or override mode');
  });

  it('rolls back without deleting when the table has unexpected columns', async () => {
    const queryRunner = runnerWith([
      [...LEGACY_COLUMNS, 'unexpected_column'].map((column_name) => ({ column_name })),
    ]);

    await expect(resetLegacyLearningRoadmap(queryRunner)).rejects.toThrow(
      'unexpected columns: unexpected_column',
    );
    expect(queryRunner.startTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.query).not.toHaveBeenCalledWith('DROP TABLE public.learning_roadmaps');
  });

  it('refuses more than one legacy test row', async () => {
    const queryRunner = runnerWith([
      LEGACY_COLUMNS.map((column_name) => ({ column_name })),
      undefined,
      [{ roadmap_count: '2' }],
    ]);

    await expect(resetLegacyLearningRoadmap(queryRunner)).rejects.toThrow('expected 0 or 1');
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.query).not.toHaveBeenCalledWith('DROP TABLE public.learning_roadmaps');
  });

  it('refuses a foreign-key dependency from another table', async () => {
    const queryRunner = runnerWith([
      LEGACY_COLUMNS.map((column_name) => ({ column_name })),
      undefined,
      [{ roadmap_count: '1' }],
      [{ constraint_name: 'fk_progress_roadmap', dependent_table: 'learning_progress' }],
    ]);

    await expect(resetLegacyLearningRoadmap(queryRunner)).rejects.toThrow(
      'learning_progress.fk_progress_roadmap',
    );
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.query).not.toHaveBeenCalledWith('DROP TABLE public.learning_roadmaps');
  });

  it('refuses to reset when a Learning V2 target table already exists', async () => {
    const queryRunner = runnerWith([
      LEGACY_COLUMNS.map((column_name) => ({ column_name })),
      undefined,
      [{ roadmap_count: '1' }],
      [],
      [{ table_name: 'learning_sessions' }],
    ]);

    await expect(resetLegacyLearningRoadmap(queryRunner)).rejects.toThrow(
      'Learning V2 target tables already exist: learning_sessions',
    );
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.query).not.toHaveBeenCalledWith('DROP TABLE public.learning_roadmaps');
  });

  it('refuses to reset when Learning V2 progress columns already exist', async () => {
    const queryRunner = runnerWith([
      LEGACY_COLUMNS.map((column_name) => ({ column_name })),
      undefined,
      [{ roadmap_count: '1' }],
      [],
      [],
      [{ column_name: 'revision' }],
    ]);

    await expect(resetLegacyLearningRoadmap(queryRunner)).rejects.toThrow(
      'Learning V2 progress columns already exist: revision',
    );
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.query).not.toHaveBeenCalledWith('DROP TABLE public.learning_roadmaps');
  });

  it('drops only the verified legacy table and exact migration history row', async () => {
    const queryRunner = runnerWith([
      LEGACY_COLUMNS.map((column_name) => ({ column_name })),
      undefined,
      [{ roadmap_count: '1' }],
      [],
      [],
      [],
      [{ table_exists: true }],
      [{ name: 'LearningRoadmaps1781110000000' }],
      undefined,
      undefined,
    ]);

    await resetLegacyLearningRoadmap(queryRunner);

    expect(queryRunner.query).toHaveBeenCalledWith('DROP TABLE public.learning_roadmaps');
    expect(queryRunner.query).toHaveBeenCalledWith(
      'DELETE FROM public.migrations WHERE name = $1',
      ['LearningRoadmaps1781110000000'],
    );
    expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
  });

  it('does not query or delete migration history when the migrations table is absent', async () => {
    const queryRunner = runnerWith([
      LEGACY_COLUMNS.map((column_name) => ({ column_name })),
      undefined,
      [{ roadmap_count: '0' }],
      [],
      [],
      [],
      [{ table_exists: false }],
      undefined,
    ]);

    await resetLegacyLearningRoadmap(queryRunner);

    const calls = jest.mocked(queryRunner.query).mock.calls;
    expect(calls.some(([sql]) => String(sql).includes('FROM public.migrations'))).toBe(false);
    expect(calls.some(([sql]) => String(sql).includes('DELETE FROM public.migrations'))).toBe(
      false,
    );
    expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
  });
});

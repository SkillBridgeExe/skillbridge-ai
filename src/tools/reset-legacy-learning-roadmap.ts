import 'dotenv/config';
import 'reflect-metadata';
import { DataSource, QueryRunner } from 'typeorm';
import { buildDataSourceOptions } from '../database/orm.config';

const LEGACY_MIGRATION = 'LearningRoadmaps1781110000000';
export const PRODUCTION_RESET_CONFIRMATION = 'DROP_ONLY_PUBLIC_LEARNING_ROADMAPS_AND_APPLY_V2';
const LEGACY_COLUMNS = new Set([
  'id',
  'user_id',
  'active',
  'source_refs',
  'composed_roadmap',
  'schedule',
  'created_at',
  'updated_at',
]);
const V2_SIGNATURE_COLUMNS = ['intent', 'status', 'revision', 'draft_config'];
const V2_TARGET_TABLES = [
  'learning_roadmap_versions',
  'learning_schedule_profiles',
  'learning_availability_slots',
  'learning_modules',
  'learning_sessions',
  'learning_quiz_attempts',
  'learning_evidence',
];
const V2_PROGRESS_COLUMNS = ['learning_session_id', 'revision'];

interface ColumnRow {
  column_name: string;
}

interface CountRow {
  roadmap_count: string | number;
}

interface DependencyRow {
  constraint_name: string;
  dependent_table: string;
}

interface MigrationRow {
  name: string;
}

interface TableExistsRow {
  table_exists: boolean | string | number;
}

interface TableNameRow {
  table_name: string;
}

interface LegacyLearningRoadmapInspection {
  hasMigrationTable: boolean;
  roadmapCount: number;
  migrationNames: string[];
}

export function assertSafeResetEnvironment(environment: NodeJS.ProcessEnv, readOnly = false): void {
  if (readOnly) return;
  const isProductionLike =
    environment.NODE_ENV === 'production' || environment.K_SERVICE || environment.ALLOW_PROD_DB;
  const hasExactConfirmation =
    environment.CONFIRM_LEGACY_LEARNING_ROADMAP_RESET === PRODUCTION_RESET_CONFIRMATION;
  if (isProductionLike && !hasExactConfirmation) {
    throw new Error('Legacy learning roadmap reset is forbidden in production or override mode.');
  }
}

export async function inspectLegacyLearningRoadmap(
  queryRunner: QueryRunner,
  lockTable = false,
): Promise<LegacyLearningRoadmapInspection> {
  const columns = (await queryRunner.query(`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'learning_roadmaps'
     ORDER BY ordinal_position
  `)) as unknown as ColumnRow[];
  assertLegacyColumns(columns.map((row) => row.column_name));

  if (lockTable) {
    await queryRunner.query('LOCK TABLE public.learning_roadmaps IN ACCESS EXCLUSIVE MODE');
  }

  const counts = (await queryRunner.query(
    'SELECT COUNT(*) AS roadmap_count FROM public.learning_roadmaps',
  )) as unknown as CountRow[];
  const roadmapCount = Number(counts[0]?.roadmap_count ?? 0);
  if (!Number.isSafeInteger(roadmapCount) || roadmapCount > 1) {
    throw new Error(
      `Refusing to reset learning_roadmaps with ${roadmapCount} rows; expected 0 or 1.`,
    );
  }

  const dependencies = (await queryRunner.query(`
    SELECT constraint_name, dependent_table
      FROM (
        SELECT c.conname AS constraint_name,
               c.conrelid::regclass::text AS dependent_table
          FROM pg_constraint c
         WHERE c.confrelid = 'public.learning_roadmaps'::regclass
           AND c.conrelid <> c.confrelid
      ) dependencies
  `)) as unknown as DependencyRow[];
  if (dependencies.length > 0) {
    throw new Error(
      `Refusing to reset learning_roadmaps because it is referenced by: ${dependencies
        .map((row) => `${row.dependent_table}.${row.constraint_name}`)
        .join(', ')}.`,
    );
  }

  const existingV2Tables = (await queryRunner.query(
    `
      SELECT table_name
        FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name
    `,
    [V2_TARGET_TABLES],
  )) as unknown as TableNameRow[];
  if (existingV2Tables.length > 0) {
    throw new Error(
      `Refusing to reset because Learning V2 target tables already exist: ${existingV2Tables
        .map((row) => row.table_name)
        .join(', ')}.`,
    );
  }

  const existingV2ProgressColumns = (await queryRunner.query(
    `
      SELECT column_name
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'learning_session_progress'
         AND column_name = ANY($1::text[])
       ORDER BY column_name
    `,
    [V2_PROGRESS_COLUMNS],
  )) as unknown as ColumnRow[];
  if (existingV2ProgressColumns.length > 0) {
    throw new Error(
      `Refusing to reset because Learning V2 progress columns already exist: ${existingV2ProgressColumns
        .map((row) => row.column_name)
        .join(', ')}.`,
    );
  }

  const migrationTableRows = (await queryRunner.query(`
    SELECT EXISTS (
      SELECT 1
        FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = 'migrations'
    ) AS table_exists
  `)) as unknown as TableExistsRow[];
  const tableExistsValue = migrationTableRows[0]?.table_exists;
  const hasMigrationTable =
    tableExistsValue === true || tableExistsValue === 'true' || tableExistsValue === 1;
  const migrations = hasMigrationTable
    ? ((await queryRunner.query(`
        SELECT name
          FROM public.migrations
         WHERE name ILIKE '%LearningRoadmap%'
         ORDER BY timestamp
      `)) as unknown as MigrationRow[])
    : [];
  const unexpected = migrations.map((row) => row.name).filter((name) => name !== LEGACY_MIGRATION);
  if (unexpected.length > 0) {
    throw new Error(
      `Refusing to reset learning_roadmaps with unexpected migration history: ${unexpected.join(', ')}.`,
    );
  }

  return {
    hasMigrationTable,
    roadmapCount,
    migrationNames: migrations.map((row) => row.name),
  };
}

export async function resetLegacyLearningRoadmap(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.startTransaction();
  try {
    const inspection = await inspectLegacyLearningRoadmap(queryRunner, true);
    await queryRunner.query('DROP TABLE public.learning_roadmaps');
    if (inspection.hasMigrationTable) {
      await queryRunner.query('DELETE FROM public.migrations WHERE name = $1', [LEGACY_MIGRATION]);
    }
    await queryRunner.commitTransaction();
  } catch (error) {
    await queryRunner.rollbackTransaction();
    throw error;
  }
}

function assertLegacyColumns(columns: string[]): void {
  if (columns.length === 0) {
    throw new Error('Refusing to reset because public.learning_roadmaps does not exist.');
  }
  const actual = new Set(columns);
  const missing = [...LEGACY_COLUMNS].filter((column) => !actual.has(column));
  const unexpected = columns.filter((column) => !LEGACY_COLUMNS.has(column));
  const hasV2Signature = V2_SIGNATURE_COLUMNS.some((column) => actual.has(column));
  if (missing.length > 0 || unexpected.length > 0 || hasV2Signature) {
    throw new Error(
      `Refusing to reset non-legacy learning_roadmaps schema; missing legacy columns: ${missing.join(', ') || 'none'}; unexpected columns: ${unexpected.join(', ') || 'none'}.`,
    );
  }
}

async function main(): Promise<void> {
  const readOnly = process.argv.includes('--check');
  assertSafeResetEnvironment(process.env, readOnly);
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');

  const dataSource = new DataSource(buildDataSourceOptions());
  await dataSource.initialize();
  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  try {
    if (readOnly) {
      const inspection = await inspectLegacyLearningRoadmap(queryRunner);
      process.stdout.write(
        `Legacy learning roadmap reset is safe: ${inspection.roadmapCount} row(s), migrations: ${inspection.migrationNames.join(', ') || 'none'}.\n`,
      );
    } else {
      await resetLegacyLearningRoadmap(queryRunner);
      process.stdout.write(
        'Reset only public.learning_roadmaps legacy data. Run migration:run next.\n',
      );
    }
  } finally {
    await queryRunner.release();
    await dataSource.destroy();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

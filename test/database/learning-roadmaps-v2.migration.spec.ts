import { QueryRunner } from 'typeorm';
import { LearningRoadmapsV21781250000000 } from '../../src/database/migrations/1781250000000-LearningRoadmapsV2';
import * as fs from 'fs';
import * as path from 'path';

describe('LearningRoadmapsV2 migration', () => {
  it('ships a guarded dev-only reset that can drop only the legacy roadmap table', () => {
    const toolPath = path.join(process.cwd(), 'src', 'tools', 'reset-legacy-learning-roadmap.ts');

    expect(fs.existsSync(toolPath)).toBe(true);
    const source = fs.readFileSync(toolPath, 'utf8');
    expect(source).toContain('information_schema.columns');
    expect(source).toContain('pg_constraint');
    expect(source).toContain('LearningRoadmaps1781110000000');
    expect(source).toContain('DROP TABLE public.learning_roadmaps');
    expect(source).toContain("process.argv.includes('--check')");
    expect(source).not.toMatch(/DROP\s+(?:DATABASE|SCHEMA)/i);
    expect(source).not.toMatch(/DROP TABLE[^;]*CASCADE/i);
  });

  it('creates the versioned roadmap domain and progress relations', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: jest.fn((sql: string) => {
        queries.push(sql);
        return Promise.resolve();
      }),
    } as unknown as QueryRunner;

    await new LearningRoadmapsV21781250000000().up(queryRunner);

    const sql = queries.join('\n');
    for (const table of [
      'learning_roadmaps',
      'learning_roadmap_versions',
      'learning_schedule_profiles',
      'learning_availability_slots',
      'learning_modules',
      'learning_sessions',
      'learning_quiz_attempts',
      'learning_evidence',
    ]) {
      expect(sql).toContain(`CREATE TABLE ${table}`);
    }
    expect(sql).toContain('ADD COLUMN learning_session_id uuid');
    expect(sql).toContain('ADD COLUMN revision integer NOT NULL DEFAULT 0');
    expect(sql).toContain('UNIQUE (roadmap_id, version_no)');
    expect(sql).toContain('CHECK (iso_weekday BETWEEN 1 AND 7)');
  });

  it('has an explicit rollback for every new table and progress column', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: jest.fn((sql: string) => {
        queries.push(sql);
        return Promise.resolve();
      }),
    } as unknown as QueryRunner;

    await new LearningRoadmapsV21781250000000().down(queryRunner);

    const sql = queries.join('\n');
    expect(sql).toContain('DROP COLUMN revision');
    expect(sql).toContain('DROP COLUMN learning_session_id');
    expect(sql).toContain('DROP TABLE learning_roadmaps');
  });
});

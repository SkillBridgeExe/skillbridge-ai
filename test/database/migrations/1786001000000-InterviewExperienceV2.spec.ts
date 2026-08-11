import { QueryRunner } from 'typeorm';
import { InterviewExperienceV21786001000000 } from '../../../src/database/migrations/1786001000000-InterviewExperienceV2';

describe('InterviewExperienceV21786001000000', () => {
  it('converts legacy hybrid sessions before restricting interview modes', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
      }),
    } as unknown as QueryRunner;

    await new InterviewExperienceV21786001000000().up(queryRunner);

    const sql = queries.join('\n');
    const conversion = "UPDATE public.interview_sessions SET mode = 'VOICE' WHERE mode = 'HYBRID'";
    const restriction = "CHECK (mode IN ('TEXT', 'VOICE'))";

    expect(sql).toContain(conversion);
    expect(sql.indexOf(conversion)).toBeLessThan(sql.indexOf(restriction));
  });
});

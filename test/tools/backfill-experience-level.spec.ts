import { computeSeniorityBackfill } from '../../src/tools/backfill-experience-level';

describe('computeSeniorityBackfill — rule: fill iff experience_level NULL AND classifySeniority(title) non-null', () => {
  it('null + "Senior Backend Developer" → fill SENIOR', () => {
    expect(
      computeSeniorityBackfill([
        { id: '1', title: 'Senior Backend Developer', experience_level: null },
      ]),
    ).toEqual([{ id: '1', title: 'Senior Backend Developer', to: 'SENIOR' }]);
  });

  it('null + "Lead Engineer" → fill LEAD', () => {
    expect(
      computeSeniorityBackfill([{ id: '2', title: 'Lead Engineer', experience_level: null }])[0],
    ).toMatchObject({ to: 'LEAD' });
  });

  it('null + level-less title ("Backend Developer") → NO change (stays null/unknown)', () => {
    expect(
      computeSeniorityBackfill([{ id: '3', title: 'Backend Developer', experience_level: null }]),
    ).toEqual([]);
  });

  it('already has a value → NEVER overridden (even if title says something else)', () => {
    expect(
      computeSeniorityBackfill([
        { id: '4', title: 'Senior Backend Developer', experience_level: 'JUNIOR' },
      ]),
    ).toEqual([]);
  });

  it('idempotent: applying then recomputing yields 0 changes', () => {
    const jobs = [
      { id: '1', title: 'Senior Backend Developer', experience_level: null as string | null },
    ];
    const applied = jobs.map((j) => {
      const ch = computeSeniorityBackfill(jobs).find((x) => x.id === j.id);
      return ch ? { ...j, experience_level: ch.to } : j;
    });
    expect(computeSeniorityBackfill(applied)).toEqual([]);
  });
});

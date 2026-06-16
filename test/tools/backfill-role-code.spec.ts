import { computeRoleBackfill } from '../../src/tools/backfill-role-code';

describe('computeRoleBackfill — rule: change iff classifyRole(title) non-null AND != stored', () => {
  it('ai_ml + "LLM Engineer" → change to ai_app_engineer', () => {
    expect(
      computeRoleBackfill([{ id: '1', title: 'LLM Engineer', role_code: 'ai_ml_engineer' }]),
    ).toEqual([{ id: '1', title: 'LLM Engineer', from: 'ai_ml_engineer', to: 'ai_app_engineer' }]);
  });

  it('null + "Prompt Engineer" → change to ai_app_engineer', () => {
    expect(
      computeRoleBackfill([{ id: '2', title: 'Prompt Engineer', role_code: null }])[0],
    ).toMatchObject({ from: null, to: 'ai_app_engineer' });
  });

  it('mobile + "Mobile AI Engineer" (classifyRole→ai_ml) → re-sync to ai_ml_engineer', () => {
    expect(
      computeRoleBackfill([{ id: '3', title: 'Mobile AI Engineer', role_code: 'mobile_developer' }])[0],
    ).toMatchObject({ from: 'mobile_developer', to: 'ai_ml_engineer' });
  });

  it('null + "Project Manager" (classifyRole→null) → NO change (NULL untouched)', () => {
    expect(computeRoleBackfill([{ id: '4', title: 'Project Manager', role_code: null }])).toEqual([]);
  });

  it('already-matching ("Backend Developer" + backend_developer) → NO change', () => {
    expect(
      computeRoleBackfill([{ id: '5', title: 'Backend Developer', role_code: 'backend_developer' }]),
    ).toEqual([]);
  });

  it('idempotent: applying then recomputing yields 0 changes', () => {
    const jobs = [{ id: '1', title: 'LLM Engineer', role_code: 'ai_ml_engineer' as string | null }];
    const applied = jobs.map((j) => {
      const ch = computeRoleBackfill(jobs).find((x) => x.id === j.id);
      return ch ? { ...j, role_code: ch.to } : j;
    });
    expect(computeRoleBackfill(applied)).toEqual([]);
  });
});

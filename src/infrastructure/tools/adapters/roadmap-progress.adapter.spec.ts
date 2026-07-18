import { RoadmapProgressAdapter } from './roadmap-progress.adapter';

jest.mock('../../../platform/learning/mastered-skills', () => {
  const actual = jest.requireActual('../../../platform/learning/mastered-skills');
  return { ...actual, masteredSkillCanonicals: jest.fn(() => new Set(['sql'])) };
});

function makeAdapter(find: jest.Mock) {
  return new RoadmapProgressAdapter({ find } as never);
}

function row(sessionId: string, checked: Record<string, string[]> = {}) {
  return { sessionId, checkedChecklistItems: checked, quizAttempts: {} };
}

describe('RoadmapProgressAdapter', () => {
  it('accepts any args shape as {} — no model-supplied arguments', () => {
    const adapter = makeAdapter(jest.fn());
    expect(adapter.argsSchema(undefined)).toEqual({});
    expect(adapter.argsSchema({ injected: 'x' })).toEqual({});
  });

  it('returns shaped-empty without a userId (never a throw)', async () => {
    const find = jest.fn();
    const result = await makeAdapter(find).invoke({}, {});
    expect(result).toEqual({ tracked: false, skills: [], mastered_count: 0 });
    expect(find).not.toHaveBeenCalled();
  });

  it('maps rows to per-skill checklist counts + mastered flags, skipping unknown session ids', async () => {
    const find = jest
      .fn()
      .mockResolvedValue([
        row('roadmap-sql', { s1: ['a', 'b'], s2: ['c'] }),
        row('roadmap-node-js'),
        row('custom-madeup-session', { s1: ['x'] }),
      ]);
    const result = await makeAdapter(find).invoke({}, { userId: 'u1' });
    expect(find).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    expect(result.tracked).toBe(true);
    expect(result.skills).toEqual([
      { skill: 'sql', checked_items: 3, mastered: true },
      { skill: 'node_js', checked_items: 0, mastered: false },
    ]);
    expect(result.mastered_count).toBe(1);
  });

  it('caps reported skills at 12 — tool payloads stay small because every number is licensed', async () => {
    const skills = [
      'react',
      'typescript',
      'javascript',
      'node-js',
      'dotnet',
      'java',
      'spring-boot',
      'python',
      'sql',
      'postgresql',
      'docker',
      'git',
      'rest-api',
      'html',
    ];
    const find = jest.fn().mockResolvedValue(skills.map((s) => row(`roadmap-${s}`)));
    const result = await makeAdapter(find).invoke({}, { userId: 'u1' });
    expect(result.skills).toHaveLength(12);
  });

  it('reports untracked when no row maps to a known skill', async () => {
    const find = jest.fn().mockResolvedValue([row('weird-id')]);
    const result = await makeAdapter(find).invoke({}, { userId: 'u1' });
    expect(result.tracked).toBe(false);
    expect(result.skills).toEqual([]);
  });
});

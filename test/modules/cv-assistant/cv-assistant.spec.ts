import {
  analyzeBulletGaps,
  buildCvAssistantTurn,
} from '../../../src/modules/cv-assistant/cv-assistant';

describe('analyzeBulletGaps — deterministic weakness detection', () => {
  it('a vague bullet is missing action + tech + result', () => {
    expect(analyzeBulletGaps('Worked on the project for a few months.', 'en')).toEqual([
      'action',
      'tech',
      'result',
    ]);
  });

  it('a strong bullet has no gaps (action + tech + measurable result)', () => {
    expect(
      analyzeBulletGaps('Built a checkout API with Node and Redis, cut p95 latency by 30%.', 'en'),
    ).toEqual([]);
  });

  it('detects a PARTIAL gap (has action, missing tech + result)', () => {
    expect(analyzeBulletGaps('Built a small dashboard.', 'en')).toEqual(['tech', 'result']);
  });

  it('works in Vietnamese (vague → all three gaps)', () => {
    expect(analyzeBulletGaps('Em làm dự án nhóm ở trường.', 'vi')).toEqual([
      'action',
      'tech',
      'result',
    ]);
  });

  it('Vietnamese strong bullet → no gaps', () => {
    expect(
      analyzeBulletGaps('Em xây API thanh toán bằng Node, giảm 30% thời gian load.', 'vi'),
    ).toEqual([]);
  });
});

describe('buildCvAssistantTurn — asks concrete questions, never fabricates', () => {
  it('a weak bullet → one structured question PER gap, each with option chips', () => {
    const turn = buildCvAssistantTurn('Worked on the project.', 'en');
    expect(turn.questions.map((q) => q.gap)).toEqual(['action', 'tech', 'result']);
    for (const q of turn.questions) {
      expect(q.prompt.length).toBeGreaterThan(0);
      expect(q.options.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('NEVER carries a field_patch before the user answers (anti-fabrication)', () => {
    expect(buildCvAssistantTurn('Worked on the project.', 'en').field_patch).toBeNull();
    expect(buildCvAssistantTurn('Em làm dự án.', 'vi').field_patch).toBeNull();
  });

  it('the weak message explicitly promises NOT to invent facts', () => {
    expect(buildCvAssistantTurn('Worked on it.', 'en').message.toLowerCase()).toContain(
      'not invent',
    );
    expect(buildCvAssistantTurn('Em làm việc đó.', 'vi').message.toLowerCase()).toContain(
      'không bịa',
    );
  });

  it('a strong bullet → no questions, a positive message', () => {
    const turn = buildCvAssistantTurn(
      'Built a checkout API with Node and Redis, cut p95 latency by 30%.',
      'en',
    );
    expect(turn.questions).toHaveLength(0);
    expect(turn.message.toLowerCase()).toContain('strong');
  });

  it('respects locale (Vietnamese UI → Vietnamese questions)', () => {
    const turn = buildCvAssistantTurn('Em làm dự án nhóm.', 'vi');
    expect(turn.questions[0].prompt).toMatch(/BẠN đã làm gì/);
  });

  it('prints a sample turn (UX demonstration)', () => {
    const turn = buildCvAssistantTurn('Làm việc trong dự án thực tập.', 'vi');
    // eslint-disable-next-line no-console
    console.log('\n--- SAMPLE TURN (vi) ---\n' + JSON.stringify(turn, null, 2) + '\n');
    expect(turn).toBeDefined();
  });
});

import {
  groundCvAssistantAnswers,
  groundCvRewrite,
} from '../../../src/modules/cv-assistant/cv-assistant-rewrite';

const OPTS = {
  target: 'projects[0].bullets[0]',
  why: 'Added action, tech, result from your answers.',
};

describe('groundCvAssistantAnswers — chips + detail → allowed facts (re-ask on bare tech)', () => {
  it('a tech category WITHOUT a concrete tech → needs_detail (re-ask, Codex fix #3)', () => {
    const out = groundCvAssistantAnswers([{ gap: 'tech', option_id: 'backend' }], 'en');
    expect(out.needs_detail).toEqual(['tech']);
    expect(out.facts).toEqual([]);
  });

  it('a tech category WITH named tech → each tech becomes a fact', () => {
    const out = groundCvAssistantAnswers(
      [{ gap: 'tech', option_id: 'backend', detail: 'Node.js, PostgreSQL' }],
      'en',
    );
    expect(out.needs_detail).toEqual([]);
    expect(out.facts).toEqual(['Node.js', 'PostgreSQL']);
  });

  it('action + result chips become qualitative facts (locale-aware)', () => {
    expect(groundCvAssistantAnswers([{ gap: 'action', option_id: 'built' }], 'vi').facts).toEqual([
      'xây',
    ]);
    expect(
      groundCvAssistantAnswers([{ gap: 'result', option_id: 'faster', detail: '30%' }], 'en').facts,
    ).toEqual(['faster', '30%']);
  });
});

describe('groundCvRewrite — rejects any fabricated fact (anti-fabrication chokepoint)', () => {
  const grounded = groundCvAssistantAnswers(
    [
      { gap: 'action', option_id: 'built' },
      { gap: 'tech', option_id: 'backend', detail: 'Node.js' },
      { gap: 'result', option_id: 'faster' },
    ],
    'en',
  ); // facts = ['built','Node.js','faster']
  const before = 'Worked on a project.';

  it('accepts a rewrite that uses ONLY grounded facts', () => {
    const v = groundCvRewrite(
      before,
      {
        after: 'Built the feature with Node.js, making it faster.',
        used_facts: ['built', 'Node.js', 'faster'],
      },
      grounded,
      OPTS,
    );
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.field_patch.after).toContain('Node.js');
  });

  it('REJECTS a fabricated number (40% the user never gave)', () => {
    const v = groundCvRewrite(
      before,
      { after: 'Built with Node.js and cut latency by 40%.', used_facts: ['built', 'Node.js'] },
      grounded,
      OPTS,
    );
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe('UNGROUNDED');
      expect(v.detail).toMatch(/40/);
    }
  });

  it('REJECTS a fabricated tech/entity (Kafka the user never mentioned)', () => {
    const v = groundCvRewrite(
      before,
      { after: 'Built it with Node.js and Kafka.', used_facts: ['built', 'Node.js'] },
      grounded,
      OPTS,
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.detail).toMatch(/Kafka/);
  });

  it('REJECTS when used_facts is not a subset of the allowed facts', () => {
    const v = groundCvRewrite(
      before,
      { after: 'Built it.', used_facts: ['built', 'Redis'] },
      grounded,
      OPTS,
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.detail).toMatch(/Redis/);
  });

  it('returns NEEDS_DETAIL (not a patch) when a gap still lacks detail', () => {
    const needsDetail = groundCvAssistantAnswers([{ gap: 'tech', option_id: 'backend' }], 'en');
    const v = groundCvRewrite(before, { after: 'x', used_facts: [] }, needsDetail, OPTS);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('NEEDS_DETAIL');
  });
});

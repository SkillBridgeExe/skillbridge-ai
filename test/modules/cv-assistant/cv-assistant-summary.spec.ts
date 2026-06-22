import { readFileSync } from 'fs';
import { join } from 'path';
import {
  analyzeSummaryGaps,
  buildSummaryTurn,
  cvBuilderAssistantTurn1,
} from '../../../src/modules/cv-assistant/cv-assistant';
import {
  groundCvAssistantAnswers,
  groundCvRewrite,
} from '../../../src/modules/cv-assistant/cv-assistant-rewrite';

describe('analyzeSummaryGaps — deterministic summary weakness detection', () => {
  it('a vague summary is missing role + strength + evidence', () => {
    expect(analyzeSummaryGaps('I am a hardworking person looking for a job.', 'en')).toEqual([
      'role',
      'strength',
      'evidence',
    ]);
  });

  it('a strong summary has no gaps (role + tech + years)', () => {
    expect(
      analyzeSummaryGaps(
        'Backend Developer with 3 years building APIs in Node.js and PostgreSQL.',
        'en',
      ),
    ).toEqual([]);
  });

  it('works in Vietnamese (vague → all three gaps)', () => {
    expect(analyzeSummaryGaps('Em là người chăm chỉ, muốn tìm việc.', 'vi')).toEqual([
      'role',
      'strength',
      'evidence',
    ]);
  });
});

describe('buildSummaryTurn + summary routing', () => {
  it('a weak summary → one question per gap, each with free-text, never a patch', () => {
    const turn = buildSummaryTurn('Looking for a job.', 'en');
    expect(turn.questions.map((q) => q.gap)).toEqual(['role', 'strength', 'evidence']);
    expect(turn.questions.every((q) => q.allows_free_text)).toBe(true);
    expect(turn.field_patch).toBeNull();
  });

  it('section=summary routes the shell to the summary turn', () => {
    const turn = cvBuilderAssistantTurn1({
      page: 'cv_builder',
      section: 'summary',
      current_value: 'Looking for a job.',
      locale: 'en',
    });
    expect(turn).not.toBeNull();
    expect(turn!.questions[0].gap).toBe('role');
  });

  it('a strong summary → no questions', () => {
    expect(
      buildSummaryTurn('Backend Developer with 3 years in Node.js.', 'en').questions,
    ).toHaveLength(0);
  });
});

describe('groundCvAssistantAnswers — summary gaps (role / strength / evidence)', () => {
  it('role chip → role fact; bare strength → re-ask; evidence chip → year fact', () => {
    const g = groundCvAssistantAnswers(
      [
        { gap: 'role', option_id: 'backend' },
        { gap: 'strength', option_id: 'backend' }, // no detail → re-ask
        { gap: 'evidence', option_id: '3_5y' },
      ],
      'en',
    );
    expect(g.needs_detail).toEqual(['strength']);
    expect(g.facts).toContain('Backend Developer');
    expect(g.facts).toContain('3-5 years');
  });

  it('strength with named skills → facts; role "other" → typed detail', () => {
    const g = groundCvAssistantAnswers(
      [
        { gap: 'role', option_id: 'other', detail: 'ML Engineer' },
        { gap: 'strength', option_id: 'data', detail: 'Python, PyTorch' },
      ],
      'en',
    );
    expect(g.needs_detail).toEqual([]);
    expect(g.facts).toEqual(expect.arrayContaining(['ML Engineer', 'Python', 'PyTorch']));
  });

  it('a grounded summary rewrite passes; a fabricated year (5) is REJECTED', () => {
    const g = groundCvAssistantAnswers(
      [
        { gap: 'role', option_id: 'backend' },
        { gap: 'strength', option_id: 'backend', detail: 'Node.js' },
        { gap: 'evidence', option_id: '1_2y' },
      ],
      'en',
    ); // facts: Backend Developer · Node.js · 1-2 years
    const before = 'Looking for a job.';
    const ok = groundCvRewrite(
      before,
      {
        after: 'Backend Developer with 1-2 years building services in Node.js.',
        used_facts: ['Backend Developer', 'Node.js', '1-2 years'],
      },
      g,
      { target: 'summary', why: 'w' },
    );
    expect(ok.ok).toBe(true);

    const bad = groundCvRewrite(
      before,
      {
        after: 'Backend Developer with 5 years in Node.js.',
        used_facts: ['Backend Developer', 'Node.js'],
      },
      g,
      { target: 'summary', why: 'w' },
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.detail).toMatch(/fabricated number: 5/);
  });
});

describe('cv_summary_rewrite_v1 prompt contract', () => {
  const prompt = readFileSync(join(process.cwd(), 'prompts', 'cv_summary_rewrite_v1.md'), 'utf8');

  it('has the system frontmatter, the input variables, JSON-only, and anti-fabrication wording', () => {
    expect(prompt.startsWith('---')).toBe(true);
    expect(prompt).toMatch(/system:/);
    for (const variable of ['language', 'before', 'facts']) {
      expect(prompt).toContain(`{{${variable}}}`);
    }
    expect(prompt.toLowerCase()).toMatch(/json only/);
    expect(prompt.toLowerCase()).toMatch(/never invent|do not introduce/);
    expect(prompt).toContain('used_facts');
  });
});

import { reconcileCvProficiency, unionJdRequirements } from './match-input-parity';
import type { ScannedSkill } from '../../common/services/skill-text-scanner.service';
import type { ReviewSkills } from './cv-review-facts';
import type { RawJdRequirement } from './skill-diff.service';

// Fake normalizer: lowercase exact map — the real cascade is taxonomy-tested elsewhere.
const CANON: Record<string, string[]> = {
  php: ['php'],
  'php (laravel is a plus)': ['php'],
  laravel: ['laravel'],
  mysql: ['mysql'],
  reactjs: ['react'],
  react: ['react'],
  javascript: ['javascript'],
  gibberishskill: [],
};
const normalize = (name: string) => CANON[name.toLowerCase()] ?? [];

const scanned = (canonical: string, text = canonical): ScannedSkill => ({
  canonical_name: canonical,
  matched_text: text,
  occurrences: 1,
});

describe('unionJdRequirements', () => {
  it('appends gazetteer hits the LLM missed, as REQUIRED with the matched surface as evidence', () => {
    const llm: RawJdRequirement[] = [{ name: 'PHP', importance_hint: 'REQUIRED' }];
    const out = unionJdRequirements(
      llm,
      [scanned('php'), scanned('laravel', 'Laravel')],
      normalize,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(llm[0]); // LLM entries keep precedence, untouched
    expect(out[1]).toEqual({
      name: 'laravel',
      importance_hint: 'REQUIRED',
      evidence_text: 'Laravel',
    });
  });

  it('dedupes via canonical, not surface spelling (ReactJS covers react)', () => {
    const llm: RawJdRequirement[] = [{ name: 'ReactJS' }];
    const out = unionJdRequirements(llm, [scanned('react')], normalize);
    expect(out).toHaveLength(1);
  });

  it('a compound LLM entry covers every canonical it names', () => {
    const llm: RawJdRequirement[] = [{ name: 'PHP (Laravel is a plus)' }];
    const out = unionJdRequirements(llm, [scanned('php'), scanned('laravel')], normalize);
    // Compound normalizes to php only in this fake map — laravel still gets appended.
    expect(out.map((r) => r.name)).toEqual(['PHP (Laravel is a plus)', 'laravel']);
  });

  it('returns the exact same array when the scan adds nothing', () => {
    const llm: RawJdRequirement[] = [{ name: 'PHP' }];
    expect(unionJdRequirements(llm, [scanned('php')], normalize)).toBe(llm);
  });
});

describe('reconcileCvProficiency', () => {
  const review: ReviewSkills = [
    { name: 'PHP', proficiency_hint: 'NOVICE', evidence_text: 'built a PHP site' },
    { name: 'MySQL', proficiency_hint: 'NOVICE', evidence_text: 'schema design' },
  ] as ReviewSkills;

  it('passes through unchanged when no review exists', () => {
    const llm = [{ name: 'PHP' }];
    expect(reconcileCvProficiency(llm, null, normalize)).toBe(llm);
    expect(reconcileCvProficiency(llm, [] as ReviewSkills, normalize)).toBe(llm);
  });

  it('fills a missing LLM hint from the review instead of the engine default 3', () => {
    const out = reconcileCvProficiency([{ name: 'PHP' }], review, normalize);
    expect(out[0].proficiency_hint).toBe('NOVICE');
  });

  it('anti-inflation: the lower level wins when both hints exist', () => {
    const out = reconcileCvProficiency(
      [{ name: 'PHP', proficiency_hint: 'ADVANCED' }],
      review,
      normalize,
    );
    expect(out[0].proficiency_hint).toBe('NOVICE');
  });

  it('keeps the LLM hint when it is already the lower one', () => {
    const out = reconcileCvProficiency(
      [{ name: 'MySQL', proficiency_hint: 'BEGINNER' }],
      review,
      normalize,
    );
    expect(out[0].proficiency_hint).toBe('BEGINNER');
  });

  it('appends review skills the fresh extraction missed', () => {
    const out = reconcileCvProficiency([{ name: 'PHP' }], review, normalize);
    expect(out.map((s) => s.name)).toEqual(['PHP', 'MySQL']);
    expect(out[1].proficiency_hint).toBe('NOVICE');
  });

  it('ignores review entries that do not normalize or carry no hint', () => {
    const messy = [
      { name: 'gibberishskill', proficiency_hint: 'EXPERT' },
      { name: 'PHP', proficiency_hint: undefined },
    ] as unknown as ReviewSkills;
    const llm = [{ name: 'JavaScript' }];
    expect(reconcileCvProficiency(llm, messy, normalize)).toEqual(llm);
  });
});

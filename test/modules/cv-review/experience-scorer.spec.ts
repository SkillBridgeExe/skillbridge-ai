import { scoreExperience } from '../../../src/modules/cv-review/experience-scorer';
import { CanonicalCvDocument, emptyCanonicalCv } from '../../../src/common/types/canonical-cv';
import { BulletFeedbackItem } from '../../../src/modules/cv-review/bullet-analyzer.service';

function doc(partial: Partial<CanonicalCvDocument>): CanonicalCvDocument {
  return { ...emptyCanonicalCv('en'), ...partial };
}

function bullet(
  section: BulletFeedbackItem['section'],
  overrides: Partial<BulletFeedbackItem> = {},
): BulletFeedbackItem {
  return {
    text: 'did something',
    section,
    verbFirst: false,
    quantified: false,
    weakOpener: false,
    firstPerson: false,
    fillerCount: 0,
    tips: [],
    ...overrides,
  };
}

describe('scoreExperience (Dim-3 deterministic scorer)', () => {
  it('strong CV: 3 experience entries + fully quantified/verb-first bullets + seniority bonus → 16-20, confidence high', () => {
    const document = doc({
      experience: [
        { org: 'A', role: 'Dev', start: '2019', end: '2021', location: null, bullets: ['x', 'y'] },
        { org: 'B', role: 'Dev2', start: '2021', end: '2022', location: null, bullets: ['z'] },
        { org: 'C', role: 'Dev3', start: '2022', end: '2023', location: null, bullets: ['w'] },
      ],
    });
    const bullets = [
      bullet('experience', { quantified: true, verbFirst: true }),
      bullet('experience', { quantified: true, verbFirst: true }),
      bullet('experience', { quantified: true, verbFirst: true }),
      bullet('experience', { quantified: true, verbFirst: true }),
    ];
    const result = scoreExperience(document, bullets);
    expect(result).not.toBeNull();
    // quantity: 3 entries * 3 = 9, +2 seniority bonus (est_years=4, confidence high) = 11
    // quality: quantifiedRatio=1 -> 5, verbFirstRatio=1 -> 3 = 8. total = 19
    expect(result!.score20).toBe(19);
    expect(result!.score20).toBeGreaterThanOrEqual(16);
    expect(result!.score20).toBeLessThanOrEqual(20);
    expect(result!.confidence).toBe('high');
  });

  it('zero experience AND zero projects → deterministic score20=2, confidence high, NOT null', () => {
    const document = doc({ experience: [], projects: [] });
    const result = scoreExperience(document, []);
    expect(result).not.toBeNull();
    expect(result!.score20).toBe(2);
    expect(result!.confidence).toBe('high');
    expect(result!.evidence).toContain('0 experience/project entries');
  });

  it('entries exist but < 2 total experience+projects bullets → null (signal too thin, keep LLM)', () => {
    const document = doc({
      experience: [
        { org: 'A', role: 'Dev', start: null, end: null, location: null, bullets: ['x'] },
      ],
    });
    const bullets = [bullet('experience')];
    expect(scoreExperience(document, bullets)).toBeNull();
  });

  it('project-only CV: scores from projects quantity, medium confidence with 3 bullets', () => {
    const document = doc({
      experience: [],
      projects: [
        { name: 'P1', role: null, tech: ['React'], bullets: ['a'], link: null },
        { name: 'P2', role: null, tech: ['Node'], bullets: ['b'], link: null },
      ],
    });
    const bullets = [
      bullet('projects', { quantified: true, verbFirst: true }),
      bullet('projects', { quantified: false, verbFirst: true }),
      bullet('projects', { quantified: false, verbFirst: false }),
    ];
    // quantity: 2 projects * 2 = 4 (no exp entries -> seniority est_years=null -> no bonus)
    // quality: quantifiedRatio=1/3=0.333 -> 4; verbFirstRatio=2/3=0.667 -> 3 = 7. total=11
    const result = scoreExperience(document, bullets);
    expect(result).not.toBeNull();
    expect(result!.score20).toBe(11);
    expect(result!.confidence).toBe('medium');
  });

  it('quantity caps at 12 even with 4 valid experience entries + seniority bonus', () => {
    const document = doc({
      experience: [
        { org: 'A', role: 'Dev', start: '2015', end: '2017', location: null, bullets: ['a', 'b'] },
        { org: 'B', role: 'Dev2', start: '2017', end: '2019', location: null, bullets: ['c'] },
        { org: 'C', role: 'Dev3', start: '2019', end: '2021', location: null, bullets: ['d'] },
        { org: 'D', role: 'Dev4', start: '2021', end: '2023', location: null, bullets: ['e'] },
      ],
    });
    const bullets = [
      bullet('experience', { quantified: true, verbFirst: true }),
      bullet('experience', { quantified: true, verbFirst: true }),
      bullet('experience', { quantified: true, verbFirst: true }),
      bullet('experience', { quantified: true, verbFirst: true }),
      bullet('experience', { quantified: true, verbFirst: true }),
    ];
    // raw quantity = 4*3=12 (already capped), quality = 5+3=8 -> total = 20
    const result = scoreExperience(document, bullets);
    expect(result!.score20).toBe(20);
  });

  it('bullets with no quantified/verb-first signal + unparseable dates → low quality score, medium confidence (1 entry), no bonus', () => {
    const document = doc({
      experience: [
        {
          org: 'A',
          role: 'Dev',
          start: null,
          end: null,
          location: null,
          bullets: ['a', 'b', 'c', 'd'],
        },
      ],
    });
    const bullets = [
      bullet('experience'),
      bullet('experience'),
      bullet('experience'),
      bullet('experience'),
    ];
    // quantity: 1 entry * 3 = 3 (dates unparseable -> seniority confidence 'low' -> no bonus)
    // quality: quantifiedRatio=0 -> 0, verbFirstRatio=0 -> 0. total = 3
    // confidence: 1 entry -> medium regardless of bullet count (per formula table)
    const result = scoreExperience(document, bullets);
    expect(result!.score20).toBe(3);
    expect(result!.confidence).toBe('medium');
  });

  it('evidence contains real-number strings tied to the actual entries/bullets', () => {
    const document = doc({
      experience: [
        { org: 'A', role: 'Dev', start: '2019', end: '2021', location: null, bullets: ['x', 'y'] },
        { org: 'B', role: 'Dev2', start: '2021', end: '2022', location: null, bullets: ['z'] },
        { org: 'C', role: 'Dev3', start: '2022', end: '2023', location: null, bullets: ['w'] },
      ],
      projects: [],
    });
    const bullets = [
      bullet('experience', { quantified: true, verbFirst: true }),
      bullet('experience', { quantified: true, verbFirst: true }),
      bullet('experience', { quantified: false, verbFirst: true }),
      bullet('experience', { quantified: false, verbFirst: false }),
    ];
    const result = scoreExperience(document, bullets);
    expect(result!.evidence).toEqual(
      expect.arrayContaining([
        '3 experience entries',
        '0 project entries',
        'est_years=4',
        'quantified 2/4 bullets',
        'verb-first 3/4 bullets',
      ]),
    );
  });

  it('seniority bonus toggles quantity by exactly 2 when est_years>=1 with confidence != low', () => {
    const withoutBonus = doc({
      experience: [
        { org: 'A', role: 'Dev', start: null, end: null, location: null, bullets: ['a', 'b'] },
        { org: 'B', role: 'Dev2', start: null, end: null, location: null, bullets: ['c', 'd'] },
      ],
    });
    const withBonus = doc({
      experience: [
        { org: 'A', role: 'Dev', start: '2020', end: '2021', location: null, bullets: ['a', 'b'] },
        { org: 'B', role: 'Dev2', start: '2021', end: '2022', location: null, bullets: ['c', 'd'] },
      ],
    });
    const bullets = [
      bullet('experience'),
      bullet('experience'),
      bullet('experience'),
      bullet('experience'),
    ];
    const noBonus = scoreExperience(withoutBonus, bullets)!;
    const bonus = scoreExperience(withBonus, bullets)!;
    // withoutBonus: dates unparseable -> confidence 'low' -> no bonus -> quantity 6, quality 0 -> 6
    // withBonus: est_years=2, confidence high -> bonus -> quantity 8, quality 0 -> 8
    expect(noBonus.score20).toBe(6);
    expect(bonus.score20).toBe(8);
    expect(bonus.score20 - noBonus.score20).toBe(2);
  });
});

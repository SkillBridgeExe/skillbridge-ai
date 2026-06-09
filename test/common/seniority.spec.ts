import { emptyCanonicalCv, CanonicalCvDocument } from '../../src/common/types/canonical-cv';
import {
  deriveCvSeniority,
  computeExperienceFit,
  experienceNudge,
} from '../../src/common/services/seniority';

const doc = (over: Partial<CanonicalCvDocument>): CanonicalCvDocument => ({
  ...emptyCanonicalCv('en'),
  ...over,
});

describe('deriveCvSeniority', () => {
  it('projects-only CV → fresher, high confidence', () => {
    const s = deriveCvSeniority(
      doc({ projects: [{ name: 'P', role: null, tech: [], bullets: ['x'], link: null }] }),
    );
    expect(s.bucket).toBe('fresher');
    expect(s.confidence).toBe('high');
  });
  it('empty CV → intern', () => {
    expect(deriveCvSeniority(emptyCanonicalCv('en')).bucket).toBe('intern');
  });
  it('one ~1-year job → junior', () => {
    const s = deriveCvSeniority(
      doc({
        experience: [
          { org: 'A', role: 'Dev', start: '01/2023', end: '12/2023', location: null, bullets: [] },
        ],
      }),
      2024,
    );
    expect(s.bucket).toBe('junior');
    expect(s.confidence).toBe('high');
  });
  it('~5 years total → senior', () => {
    const s = deriveCvSeniority(
      doc({
        experience: [
          { org: 'A', role: 'Dev', start: '2019', end: 'Present', location: null, bullets: [] },
        ],
      }),
      2024,
    );
    expect(s.bucket).toBe('senior');
  });
  it('unparseable dates → low confidence, count fallback (1 entry → junior)', () => {
    const s = deriveCvSeniority(
      doc({
        experience: [
          {
            org: 'A',
            role: 'Dev',
            start: 'a while ago',
            end: 'recently',
            location: null,
            bullets: [],
          },
        ],
      }),
    );
    expect(s.confidence).toBe('low');
    expect(s.bucket).toBe('junior');
  });
});

describe('computeExperienceFit', () => {
  const sen = (bucket: any) => ({
    bucket,
    est_years: null,
    confidence: 'high' as const,
    signals: [],
  });
  it('fresher vs SENIOR → stretch', () => {
    expect(computeExperienceFit(sen('fresher'), 'SENIOR').verdict).toBe('stretch');
  });
  it('mid vs MIDDLE → fits', () => {
    expect(computeExperienceFit(sen('mid'), 'MIDDLE').verdict).toBe('fits');
  });
  it('senior vs JUNIOR → over_qualified', () => {
    expect(computeExperienceFit(sen('senior'), 'JUNIOR').verdict).toBe('over_qualified');
  });
  it('null job level or null cv → unknown', () => {
    expect(computeExperienceFit(sen('mid'), null).verdict).toBe('unknown');
    expect(computeExperienceFit(null, 'MIDDLE').verdict).toBe('unknown');
  });
});

describe('experienceNudge', () => {
  it('fits positive, stretch negative, unknown zero; confidence scales magnitude', () => {
    const f = (verdict: any, confidence: any = 'high') => ({
      cv_seniority: 'mid' as const,
      job_level: 'MIDDLE',
      verdict,
      confidence,
    });
    expect(experienceNudge(f('fits'))).toBeGreaterThan(0);
    expect(experienceNudge(f('stretch'))).toBeLessThan(0);
    expect(experienceNudge(f('unknown'))).toBe(0);
    expect(Math.abs(experienceNudge(f('fits', 'low')))).toBeLessThan(
      Math.abs(experienceNudge(f('fits', 'high'))),
    );
  });
});

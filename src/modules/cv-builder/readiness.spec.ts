import { computeReadiness, cvSkillsFromDoc } from './readiness';
import { emptyCanonicalCv } from '../../common/types/canonical-cv';

describe('computeReadiness', () => {
  it('blends overall_score and required_coverage into 0-100', () => {
    // 0.6*80 + 40*0.5 = 48 + 20 = 68
    expect(computeReadiness(80, 0.5).readiness).toBe(68);
  });
  it('bands: <40 starting, <70 building, >=70 ready', () => {
    expect(computeReadiness(0, 0).band).toBe('starting'); // 0
    expect(computeReadiness(80, 0.5).band).toBe('building'); // 68
    expect(computeReadiness(100, 1).band).toBe('ready'); // 0.6*100+40 = 100
    expect(computeReadiness(60, 0.0).band).toBe('starting'); // 36
    expect(computeReadiness(50, 0.25).band).toBe('building'); // 30+10=40 → building (boundary)
  });
});

describe('cvSkillsFromDoc', () => {
  it('collects technical skills + project tech, deduped, as RawCvSkill[]', () => {
    const doc = emptyCanonicalCv('vi');
    doc.skills.technical = ['React', 'sql'];
    doc.projects.push({ name: 'P1', role: null, tech: ['sql', 'docker'], bullets: [], link: null });
    const skills = cvSkillsFromDoc(doc)
      .map((s) => s.name.toLowerCase())
      .sort();
    expect(skills).toEqual(['docker', 'react', 'sql']); // sql deduped
  });
  it('returns [] for an empty doc', () => {
    expect(cvSkillsFromDoc(emptyCanonicalCv('vi'))).toEqual([]);
  });
});

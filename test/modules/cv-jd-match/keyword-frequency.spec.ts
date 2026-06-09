import { buildKeywordFrequency } from '../../../src/modules/cv-jd-match/cv-jd-match.service';
import { ScannedSkill } from '../../../src/common/services/skill-text-scanner.service';

describe('buildKeywordFrequency', () => {
  it('counts CV vs JD occurrences over the requirement set (0 when absent, deduped)', () => {
    const cvScan: ScannedSkill[] = [
      { canonical_name: 'react', matched_text: 'React', occurrences: 3 },
    ];
    const jdScan: ScannedSkill[] = [
      { canonical_name: 'react', matched_text: 'React', occurrences: 5 },
      { canonical_name: 'git', matched_text: 'Git', occurrences: 2 },
    ];
    const reqSkills = [
      { canonical_name: 'react', display_name: 'React' },
      { canonical_name: 'git', display_name: 'Git' },
      { canonical_name: 'react', display_name: 'React' }, // duplicate → deduped
    ];
    expect(buildKeywordFrequency(reqSkills, cvScan, jdScan)).toEqual([
      { canonical_name: 'react', display_name: 'React', cv_count: 3, jd_count: 5 },
      { canonical_name: 'git', display_name: 'Git', cv_count: 0, jd_count: 2 },
    ]);
  });
});

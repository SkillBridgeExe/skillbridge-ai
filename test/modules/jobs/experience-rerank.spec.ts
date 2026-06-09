import { rerankByExperience } from '../../../src/modules/jobs/reco/job-recommendation.service';
import { ExperienceFit } from '../../../src/common/services/seniority';

const fit = (verdict: any): ExperienceFit => ({
  cv_seniority: 'fresher',
  job_level: 'X',
  verdict,
  confidence: 'high',
});

describe('rerankByExperience', () => {
  it('reorders a NEAR-TIE in favor of the better fit', () => {
    const fused = new Map([
      ['jobStretch', 0.0164],
      ['jobFits', 0.0162],
    ]); // ~1 rank apart
    const fits = new Map<string, ExperienceFit>([
      ['jobStretch', fit('stretch')],
      ['jobFits', fit('fits')],
    ]);
    const order = rerankByExperience(fused, fits).map(([id]) => id);
    expect(order[0]).toBe('jobFits');
  });
  it('does NOT displace a clear skill-winner', () => {
    const fused = new Map([
      ['winnerStretch', 0.02],
      ['fitsFar', 0.01],
    ]); // big gap
    const fits = new Map<string, ExperienceFit>([
      ['winnerStretch', fit('stretch')],
      ['fitsFar', fit('fits')],
    ]);
    const order = rerankByExperience(fused, fits).map(([id]) => id);
    expect(order[0]).toBe('winnerStretch');
  });
});

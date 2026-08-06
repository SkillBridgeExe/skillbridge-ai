import { toJobRecommendationOptions } from '../../../src/modules/jobs/dto/job-recommendation-query.dto';
import { JOB_ROLE_CODES, type RoleCode } from '../../../src/modules/jobs/ingest/ingest-normalizers';

describe('job marketplace role contract', () => {
  it('uses one authoritative registry for every supported recommendation role', () => {
    expect(JOB_ROLE_CODES).toEqual([
      'frontend_developer',
      'backend_developer',
      'fullstack_developer',
      'data_analyst',
      'mobile_developer',
      'devops_engineer',
      'qa_tester',
      'ai_ml_engineer',
      'ai_app_engineer',
    ]);

    for (const role of JOB_ROLE_CODES) {
      expect(toJobRecommendationOptions({ role }).roleCode).toBe(role satisfies RoleCode);
    }
  });

  it('keeps diagnosis-only roles outside the job marketplace contract', () => {
    expect(() => toJobRecommendationOptions({ role: 'security_engineer' })).toThrow(
      'role contains unsupported value: security_engineer',
    );
  });
});

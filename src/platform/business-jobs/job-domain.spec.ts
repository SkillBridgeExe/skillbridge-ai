import {
  assertApplicationTransition,
  assertApplyableJob,
  assertExpectedRevision,
  evaluateJobPublishReadiness,
  assertPublishableDraft,
  assertPublishDeadline,
  publicSalary,
  proficiencyHintForLevel,
  retentionDateForApplication,
  safeApplication,
} from './job-domain';

describe('business jobs domain policies', () => {
  describe('application status transitions', () => {
    it.each([
      ['SUBMITTED', 'IN_REVIEW'],
      ['SUBMITTED', 'REJECTED'],
      ['IN_REVIEW', 'SHORTLISTED'],
      ['IN_REVIEW', 'REJECTED'],
      ['SHORTLISTED', 'REJECTED'],
      ['SUBMITTED', 'WITHDRAWN'],
      ['IN_REVIEW', 'WITHDRAWN'],
      ['SHORTLISTED', 'WITHDRAWN'],
    ] as const)('allows %s -> %s', (from, to) => {
      expect(() => assertApplicationTransition(from, to)).not.toThrow();
    });

    it.each([
      ['REJECTED', 'IN_REVIEW'],
      ['WITHDRAWN', 'SUBMITTED'],
      ['SUBMITTED', 'SHORTLISTED'],
      ['SHORTLISTED', 'IN_REVIEW'],
    ] as const)('rejects %s -> %s', (from, to) => {
      expect(() => assertApplicationTransition(from, to)).toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ errorCode: 'INVALID_APPLICATION_STATUS_TRANSITION' }),
        }),
      );
    });
  });

  it('accepts only a future deadline no more than 60 days away', () => {
    const now = new Date('2026-06-21T00:00:00.000Z');
    expect(() => assertPublishDeadline(new Date('2026-08-20T00:00:00.000Z'), now)).not.toThrow();
    expect(() => assertPublishDeadline(new Date('2026-06-20T00:00:00.000Z'), now)).toThrow();
    expect(() => assertPublishDeadline(new Date('2026-08-21T00:00:00.001Z'), now)).toThrow();
  });

  it('reports every publish blocker with stable field-level codes', () => {
    const readiness = evaluateJobPublishReadiness({
      companyStatus: 'DRAFT',
      title: ' ',
      roleCode: 'sales_manager',
      summary: ' ',
      responsibilities: [],
      requirements: [],
      locations: [{ cityCode: ' ', countryCode: 'VNM', isPrimary: true }],
      skills: [],
      skillsConfirmedAt: null,
      applicationDeadline: null,
      salaryMin: 30,
      salaryMax: 20,
      minYearsExperience: 5,
      maxYearsExperience: 3,
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'BUSINESS_NOT_VERIFIED', field: 'companyStatus' }),
        expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'title' }),
        expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'roleCode' }),
        expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'summary' }),
        expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'responsibilities' }),
        expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'requirements' }),
        expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'locations' }),
        expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'applicationDeadline' }),
        expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'skills' }),
        expect.objectContaining({ code: 'JOB_SKILLS_NOT_CONFIRMED', field: 'skillsConfirmedAt' }),
        expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'salaryMin' }),
        expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'minYearsExperience' }),
      ]),
    );
  });

  it('accepts an address-free valid location and valid numeric ranges', () => {
    const complete = {
      companyStatus: 'VERIFIED',
      title: 'Backend Developer',
      roleCode: 'backend_developer',
      summary: 'Build APIs',
      responsibilities: ['Build and operate APIs'],
      requirements: ['Node.js'],
      locations: [{ cityCode: ' HCM ', countryCode: 'vn', isPrimary: true }],
      skills: [{ skillId: 'skill-1' }],
      skillsConfirmedAt: new Date(),
      applicationDeadline: new Date('2026-07-01T00:00:00.000Z'),
      salaryMin: 20,
      salaryMax: 30,
      minYearsExperience: 1,
      maxYearsExperience: 3,
    };
    expect(evaluateJobPublishReadiness(complete, new Date('2026-06-21T00:00:00.000Z'))).toEqual({
      ready: true,
      blockers: [],
    });
    expect(() => assertPublishableDraft(complete)).not.toThrow();
    expect(() => assertPublishableDraft({ ...complete, locations: [] })).toThrow();
    expect(() => assertPublishableDraft({ ...complete, skillsConfirmedAt: null })).toThrow();
    expect(() => assertPublishableDraft({ ...complete, roleCode: 'sales_manager' })).toThrow();
  });

  it('accepts applications only for the current active native version', () => {
    const active = {
      status: 'active',
      applicationMode: 'NATIVE',
      currentPublishedVersionId: 'version-1',
      expiresAt: new Date('2026-07-01T00:00:00.000Z'),
    } as const;
    const now = new Date('2026-06-21T00:00:00.000Z');
    expect(() => assertApplyableJob(active, 'version-1', now)).not.toThrow();
    expect(() =>
      assertApplyableJob({ ...active, applicationMode: 'EXTERNAL' }, 'version-1', now),
    ).toThrow();
    expect(() => assertApplyableJob(active, 'version-2', now)).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ errorCode: 'JOB_VERSION_CHANGED' }),
      }),
    );
    expect(() => assertApplyableJob({ ...active, expiresAt: now }, 'version-1', now)).toThrow();
  });

  it('rejects a stale optimistic revision', () => {
    expect(() => assertExpectedRevision(3, 3)).not.toThrow();
    expect(() => assertExpectedRevision(2, 3)).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ errorCode: 'JOB_VERSION_CONFLICT' }),
      }),
    );
  });

  it('does not expose a hidden salary range publicly', () => {
    expect(
      publicSalary({
        visible: false,
        min: 20_000_000,
        max: 30_000_000,
        currency: 'VND',
        period: 'MONTH',
        negotiable: true,
      }),
    ).toEqual({
      min: null,
      max: null,
      currency: 'VND',
      period: 'MONTH',
      negotiable: true,
      visible: false,
    });
  });

  it('maps numeric job skill levels to the shared proficiency scale', () => {
    expect([1, 2, 3, 4, 5].map(proficiencyHintForLevel)).toEqual([
      'BEGINNER',
      'NOVICE',
      'INTERMEDIATE',
      'ADVANCED',
      'EXPERT',
    ]);
  });

  it('purges rejected or withdrawn application PII 90 days after terminal time', () => {
    expect(
      retentionDateForApplication({
        status: 'REJECTED',
        terminalAt: new Date('2026-01-01T00:00:00.000Z'),
        jobEndedAt: new Date('2026-02-01T00:00:00.000Z'),
      }).toISOString(),
    ).toBe('2026-04-01T00:00:00.000Z');
  });

  it('purges non-terminal application PII 90 days after the job ends', () => {
    expect(
      retentionDateForApplication({
        status: 'SHORTLISTED',
        terminalAt: null,
        jobEndedAt: new Date('2026-02-01T00:00:00.000Z'),
      }).toISOString(),
    ).toBe('2026-05-02T00:00:00.000Z');
  });

  it('returns a safe application with a normalized match explanation', () => {
    expect(
      safeApplication({
        id: 'application-1',
        cvStorageObjectKey: 'private/cv.pdf',
        cvChecksumSha256: 'secret-checksum',
        matchStatus: 'READY' as const,
        matchScore: '91.25',
        matchScoringVersion: 'skill-diff-v2',
        matchErrorCode: null,
        matchResult: { score_basis: 'skills_only', matched_skills: [] },
      }),
    ).toEqual(
      expect.objectContaining({
        id: 'application-1',
        matchExplanation: expect.objectContaining({ status: 'READY', score: 91.25 }),
      }),
    );
    expect(
      safeApplication({
        cvStorageObjectKey: 'private/cv.pdf',
        cvChecksumSha256: 'secret-checksum',
        matchStatus: 'PENDING' as const,
        matchScore: null,
        matchScoringVersion: null,
        matchErrorCode: null,
        matchResult: null,
      }),
    ).not.toEqual(expect.objectContaining({ cvStorageObjectKey: expect.anything() }));
  });
});

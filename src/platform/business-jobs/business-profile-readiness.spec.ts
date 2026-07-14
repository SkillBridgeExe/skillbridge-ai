import { businessProfileBlockers } from './business-profile-readiness';

describe('businessProfileBlockers', () => {
  const complete = {
    profile: {
      status: 'DRAFT' as const,
      contactName: 'Linh Nguyen',
      workEmailDomain: 'acme.vn',
      workEmailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
    },
    company: {
      name: 'Acme',
      website: 'https://acme.vn',
      industryCode: 'TECH',
      shortDescription: 'A technology company',
    },
  };

  it('returns no blockers for a complete, verified-domain profile', () => {
    expect(businessProfileBlockers(complete.profile, complete.company)).toEqual([]);
  });

  it('returns stable blocker codes for incomplete and suspended profiles', () => {
    expect(
      businessProfileBlockers(
        {
          ...complete.profile,
          status: 'SUSPENDED',
          contactName: null,
          workEmailDomain: 'other.vn',
          workEmailVerifiedAt: null,
        },
        { ...complete.company, industryCode: null, shortDescription: null },
      ),
    ).toEqual([
      'PROFILE_SUSPENDED',
      'WORK_EMAIL_UNVERIFIED',
      'CONTACT_NAME_MISSING',
      'WORK_EMAIL_DOMAIN_MISMATCH',
      'INDUSTRY_MISSING',
      'SHORT_DESCRIPTION_MISSING',
    ]);
  });
});

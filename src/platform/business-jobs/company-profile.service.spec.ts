import { BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';
import { ObjectLiteral, Repository } from 'typeorm';
import { BusinessProfileEntity } from '../../database/entities/business-profile.entity';
import { CompanyEntity } from '../../database/entities/company.entity';
import { VerificationEntity } from '../../database/entities/verification.entity';
import { CompanyProfileService, domainsMatch } from './company-profile.service';

function repo<T extends ObjectLiteral>() {
  return {
    findOne: jest.fn(),
    create: jest.fn((value) => value),
    save: jest.fn(async (value) => value),
    update: jest.fn(),
    findAndCount: jest.fn(),
  } as unknown as jest.Mocked<Repository<T>>;
}

function transactionSource(
  profiles: Repository<BusinessProfileEntity>,
  companies: Repository<CompanyEntity>,
  verifications: Repository<VerificationEntity> = repo<VerificationEntity>(),
) {
  return {
    transaction: jest.fn(async (work) =>
      work({
        getRepository: (target: unknown) => {
          if (target === CompanyEntity) return companies;
          if (target === VerificationEntity) return verifications;
          return profiles;
        },
      }),
    ),
  };
}

describe('CompanyProfileService', () => {
  it('accepts the company domain and its subdomains but rejects unrelated email providers', () => {
    expect(domainsMatch('https://careers.acme.vn/jobs', 'acme.vn')).toBe(true);
    expect(domainsMatch('https://acme.vn', 'mail.acme.vn')).toBe(true);
    expect(domainsMatch('https://acme.vn', 'gmail.com')).toBe(false);
  });

  it('resets a verified profile to draft when company identity changes', async () => {
    const profiles = repo<BusinessProfileEntity>();
    const companies = repo<CompanyEntity>();
    const service = new CompanyProfileService(
      profiles,
      companies,
      repo<VerificationEntity>(),
      { sendVerifyEmail: jest.fn() } as never,
      { get: jest.fn(() => 'https://app.test') } as never,
      {} as never,
      transactionSource(profiles, companies) as never,
    );
    profiles.findOne.mockResolvedValue({
      id: 'profile-1',
      userId: 'business-1',
      companyId: 'company-1',
      status: 'VERIFIED',
      workEmail: 'hr@acme.vn',
      workEmailNormalized: 'hr@acme.vn',
      workEmailDomain: 'acme.vn',
      workEmailVerifiedAt: new Date(),
      submittedAt: new Date(),
      reviewedAt: new Date(),
    } as BusinessProfileEntity);
    companies.findOne.mockResolvedValue({
      id: 'company-1',
      name: 'Acme',
      nameNormalized: 'acme',
      website: 'https://acme.vn',
      benefits: [],
    } as unknown as CompanyEntity);

    const result = await service.updateMyCompany('business-1', { website: 'https://new-acme.vn' });

    expect(result.profile.status).toBe('DRAFT');
    expect(result.profile.submittedAt).toBeNull();
    expect(result.company).not.toHaveProperty('logoObjectKey');
    expect(result.company).not.toHaveProperty('coverObjectKey');
    expect(profiles.save).toHaveBeenCalled();
  });

  it('updates company identity and verification state in one transaction', async () => {
    const profiles = repo<BusinessProfileEntity>();
    const companies = repo<CompanyEntity>();
    profiles.findOne.mockResolvedValue({
      id: 'profile-1',
      userId: 'business-1',
      companyId: 'company-1',
      status: 'VERIFIED',
      workEmailNormalized: 'hr@acme.vn',
      submittedAt: new Date(),
      reviewedAt: new Date(),
    } as BusinessProfileEntity);
    companies.findOne.mockResolvedValue({
      id: 'company-1',
      name: 'Acme',
      nameNormalized: 'acme',
      website: 'https://acme.vn',
      benefits: [],
    } as unknown as CompanyEntity);
    const dataSource = {
      transaction: jest.fn(async (work) =>
        work({
          getRepository: (target: unknown) => (target === CompanyEntity ? companies : profiles),
        }),
      ),
    };
    const service = new CompanyProfileService(
      profiles,
      companies,
      repo<VerificationEntity>(),
      { sendVerifyEmail: jest.fn() } as never,
      { get: jest.fn() } as never,
      {} as never,
      dataSource as never,
    );

    await service.updateMyCompany('business-1', { website: 'https://new-acme.vn' });

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
  });

  it('consumes the work-email token and verifies the profile atomically', async () => {
    const profiles = repo<BusinessProfileEntity>();
    const companies = repo<CompanyEntity>();
    const verifications = repo<VerificationEntity>();
    const email = 'hr@acme.vn';
    profiles.findOne.mockResolvedValue({
      id: 'profile-1',
      userId: 'business-1',
      companyId: 'company-1',
      workEmailNormalized: email,
      workEmailVerifiedAt: null,
    } as BusinessProfileEntity);
    verifications.findOne.mockResolvedValue({
      id: 'verification-1',
      userId: 'business-1',
      purpose: 'BUSINESS_EMAIL_VERIFY',
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      targetValueHash: createHash('sha256').update(email).digest('hex'),
    } as VerificationEntity);
    const dataSource = {
      transaction: jest.fn(async (work) =>
        work({
          getRepository: (target: unknown) =>
            target === VerificationEntity ? verifications : profiles,
        }),
      ),
    };
    const service = new CompanyProfileService(
      profiles,
      companies,
      verifications,
      { sendVerifyEmail: jest.fn() } as never,
      { get: jest.fn() } as never,
      {} as never,
      dataSource as never,
    );

    await service.verifyWorkEmail('token');

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
  });

  it('returns owner media URLs without exposing private storage keys', async () => {
    const profiles = repo<BusinessProfileEntity>();
    const companies = repo<CompanyEntity>();
    profiles.findOne.mockResolvedValue({
      id: 'profile-1',
      userId: 'business-1',
      companyId: 'company-1',
      status: 'DRAFT',
    } as BusinessProfileEntity);
    companies.findOne.mockResolvedValue({
      id: 'company-1',
      slug: 'acme',
      name: 'Acme',
      logoObjectKey: 'companies/company-1/logo/logo.png',
      coverObjectKey: 'companies/company-1/cover/cover.png',
      benefits: [],
    } as unknown as CompanyEntity);
    const service = new CompanyProfileService(
      profiles,
      companies,
      repo<VerificationEntity>(),
      { sendVerifyEmail: jest.fn() } as never,
      { get: jest.fn() } as never,
      { download: jest.fn() } as never,
      {} as never,
    );

    const result = await service.getMyCompany('business-1');

    expect(result?.company).not.toHaveProperty('logoObjectKey');
    expect(result?.company).not.toHaveProperty('coverObjectKey');
    expect(result?.company).toEqual(
      expect.objectContaining({
        logoUrl: '/api/business/company/logo',
        coverUrl: '/api/business/company/cover',
      }),
    );
  });

  it('downloads company media for the owning business before public verification', async () => {
    const profiles = repo<BusinessProfileEntity>();
    const companies = repo<CompanyEntity>();
    const storage = {
      download: jest.fn().mockResolvedValue({ body: {}, contentType: 'image/png' }),
    };
    profiles.findOne.mockResolvedValue({
      id: 'profile-1',
      userId: 'business-1',
      companyId: 'company-1',
      status: 'DRAFT',
    } as BusinessProfileEntity);
    companies.findOne.mockResolvedValue({
      id: 'company-1',
      logoObjectKey: 'companies/company-1/logo/logo.png',
      benefits: [],
    } as unknown as CompanyEntity);
    const service = new CompanyProfileService(
      profiles,
      companies,
      repo<VerificationEntity>(),
      { sendVerifyEmail: jest.fn() } as never,
      { get: jest.fn() } as never,
      storage as never,
      {} as never,
    );

    await service.downloadMyMedia('business-1', 'logo');

    expect(storage.download).toHaveBeenCalledWith('companies/company-1/logo/logo.png');
  });

  it('invalidates old work-email tokens and creates the new token atomically', async () => {
    const profiles = repo<BusinessProfileEntity>();
    const companies = repo<CompanyEntity>();
    const verifications = repo<VerificationEntity>();
    profiles.findOne.mockResolvedValue({
      id: 'profile-1',
      userId: 'business-1',
      companyId: 'company-1',
      workEmailNormalized: 'hr@acme.vn',
      workEmailDomain: 'acme.vn',
    } as BusinessProfileEntity);
    companies.findOne.mockResolvedValue({
      id: 'company-1',
      website: 'https://acme.vn',
    } as CompanyEntity);
    const dataSource = transactionSource(profiles, companies, verifications);
    const service = new CompanyProfileService(
      profiles,
      companies,
      verifications,
      { sendVerifyEmail: jest.fn().mockResolvedValue(undefined) } as never,
      { get: jest.fn(() => 'https://app.test') } as never,
      {} as never,
      dataSource as never,
    );

    await service.sendWorkEmailVerification('business-1');

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(verifications.update).toHaveBeenCalled();
    expect(verifications.save).toHaveBeenCalled();
  });

  it.each(['PENDING_REVIEW', 'REJECTED'] as const)(
    'resets a %s profile to draft when company identity changes',
    async (status) => {
      const profiles = repo<BusinessProfileEntity>();
      const companies = repo<CompanyEntity>();
      profiles.findOne.mockResolvedValue({
        id: 'profile-1',
        userId: 'business-1',
        companyId: 'company-1',
        status,
        workEmailNormalized: 'hr@acme.vn',
        submittedAt: new Date(),
      } as BusinessProfileEntity);
      companies.findOne.mockResolvedValue({
        id: 'company-1',
        name: 'Acme',
        nameNormalized: 'acme',
        website: 'https://acme.vn',
        benefits: [],
      } as unknown as CompanyEntity);
      const service = new CompanyProfileService(
        profiles,
        companies,
        repo<VerificationEntity>(),
        { sendVerifyEmail: jest.fn() } as never,
        { get: jest.fn(() => 'https://app.test') } as never,
        {} as never,
        transactionSource(profiles, companies) as never,
      );

      const result = await service.updateMyCompany('business-1', {
        website: 'https://new-acme.vn',
      });

      expect(result.profile.status).toBe('DRAFT');
      expect(result.profile.submittedAt).toBeNull();
    },
  );

  it('reuses an unclaimed canonical company already present in the crawler pool', async () => {
    const profiles = repo<BusinessProfileEntity>();
    const companies = repo<CompanyEntity>();
    profiles.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    companies.findOne.mockResolvedValue({
      id: 'company-existing',
      name: 'Acme',
      nameNormalized: 'acme',
      slug: 'company-existing',
      countryCode: 'VN',
      benefits: [],
      website: null,
    } as unknown as CompanyEntity);
    const service = new CompanyProfileService(
      profiles,
      companies,
      repo<VerificationEntity>(),
      { sendVerifyEmail: jest.fn() } as never,
      { get: jest.fn(() => 'https://app.test') } as never,
      {} as never,
      transactionSource(profiles, companies) as never,
    );

    const result = await service.updateMyCompany('business-1', { companyName: 'ACME' });

    expect(result.company.id).toBe('company-existing');
    expect(companies.create).not.toHaveBeenCalled();
    expect(profiles.save).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-existing' }),
    );
  });

  it('does not allow submission until work email is verified', async () => {
    const profiles = repo<BusinessProfileEntity>();
    const companies = repo<CompanyEntity>();
    const service = new CompanyProfileService(
      profiles,
      companies,
      repo<VerificationEntity>(),
      { sendVerifyEmail: jest.fn() } as never,
      { get: jest.fn(() => 'https://app.test') } as never,
      {} as never,
      {} as never,
    );
    profiles.findOne.mockResolvedValue({
      id: 'profile-1',
      userId: 'business-1',
      companyId: 'company-1',
      status: 'DRAFT',
      workEmailVerifiedAt: null,
      contactName: 'Recruiter',
    } as BusinessProfileEntity);
    companies.findOne.mockResolvedValue({
      id: 'company-1',
      name: 'Acme',
      website: 'https://acme.vn',
      industryCode: 'software',
      shortDescription: 'An engineering company',
    } as unknown as CompanyEntity);

    await expect(service.submitMyCompany('business-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('does not let a suspended business resubmit itself for review', async () => {
    const profiles = repo<BusinessProfileEntity>();
    const companies = repo<CompanyEntity>();
    profiles.findOne.mockResolvedValue({
      id: 'profile-1',
      userId: 'business-1',
      companyId: 'company-1',
      status: 'SUSPENDED',
      workEmailVerifiedAt: new Date(),
      workEmailDomain: 'acme.vn',
      contactName: 'Recruiter',
    } as BusinessProfileEntity);
    companies.findOne.mockResolvedValue({
      id: 'company-1',
      name: 'Acme',
      website: 'https://acme.vn',
      industryCode: 'software',
      shortDescription: 'An engineering company',
    } as unknown as CompanyEntity);
    const service = new CompanyProfileService(
      profiles,
      companies,
      repo<VerificationEntity>(),
      { sendVerifyEmail: jest.fn() } as never,
      { get: jest.fn() } as never,
      {} as never,
      {} as never,
    );

    await expect(service.submitMyCompany('business-1')).rejects.toMatchObject({
      status: 403,
      response: expect.objectContaining({ errorCode: 'BUSINESS_NOT_VERIFIED' }),
    });
    expect(profiles.save).not.toHaveBeenCalled();
  });

  it('does not expose private company storage object keys publicly', async () => {
    const profiles = repo<BusinessProfileEntity>();
    const companies = repo<CompanyEntity>();
    companies.findOne.mockResolvedValue({
      id: 'company-1',
      slug: 'acme',
      name: 'Acme',
      logoObjectKey: 'companies/c/logo/a.png',
      coverObjectKey: 'companies/c/cover/b.png',
      benefits: [],
    } as unknown as CompanyEntity);
    profiles.findOne.mockResolvedValue({
      companyId: 'company-1',
      status: 'VERIFIED',
    } as BusinessProfileEntity);
    const service = new CompanyProfileService(
      profiles,
      companies,
      repo<VerificationEntity>(),
      { sendVerifyEmail: jest.fn() } as never,
      { get: jest.fn() } as never,
      {} as never,
      {} as never,
    );

    const publicCompany = await service.getPublicCompany('acme');

    expect(publicCompany).not.toHaveProperty('logoObjectKey');
    expect(publicCompany).not.toHaveProperty('coverObjectKey');
    expect(publicCompany).toEqual(
      expect.objectContaining({
        logoUrl: '/api/companies/acme/logo',
        coverUrl: '/api/companies/acme/cover',
      }),
    );
  });
});

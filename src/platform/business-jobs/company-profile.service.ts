import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'crypto';
import { DataSource, IsNull, Repository } from 'typeorm';
import {
  BusinessProfileEntity,
  BusinessProfileStatus,
} from '../../database/entities/business-profile.entity';
import { CompanyEntity, CompanySize, CompanyType } from '../../database/entities/company.entity';
import { VerificationEntity } from '../../database/entities/verification.entity';
import { EmailService } from '../../infrastructure/email/email.service';
import {
  DownloadedFile,
  GcsStorageService,
} from '../../infrastructure/storage/gcs-storage.service';

export interface UpdateCompanyInput {
  companyName?: string;
  website?: string | null;
  workEmail?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  linkedinUrl?: string | null;
  industryCode?: string | null;
  companyType?: CompanyType | null;
  companySize?: CompanySize | null;
  foundedYear?: number | null;
  countryCode?: string;
  headquartersCityCode?: string | null;
  headquartersAddress?: string | null;
  shortDescription?: string | null;
  description?: string | null;
  cultureDescription?: string | null;
  benefits?: string[];
}

@Injectable()
export class CompanyProfileService {
  constructor(
    @InjectRepository(BusinessProfileEntity)
    private readonly profiles: Repository<BusinessProfileEntity>,
    @InjectRepository(CompanyEntity)
    private readonly companies: Repository<CompanyEntity>,
    @InjectRepository(VerificationEntity)
    private readonly verifications: Repository<VerificationEntity>,
    private readonly email: EmailService,
    private readonly config: ConfigService,
    private readonly storage: GcsStorageService,
    private readonly dataSource: DataSource,
  ) {}

  async getMyCompany(userId: string) {
    const aggregate = await this.getOwnedEntities(userId);
    if (!aggregate) return null;
    return {
      profile: aggregate.profile,
      company: toOwnedCompanyDto(aggregate.company),
    };
  }

  async updateMyCompany(userId: string, input: UpdateCompanyInput) {
    return this.dataSource.transaction(async (manager) => {
      const profiles = manager.getRepository(BusinessProfileEntity);
      const companies = manager.getRepository(CompanyEntity);
      let profile = await profiles.findOne({ where: { userId } });
      let company: CompanyEntity;
      if (!profile) {
        const name = input.companyName?.trim();
        if (!name) {
          throw new BadRequestException({
            errorCode: 'VALIDATION_ERROR',
            message: 'companyName is required',
          });
        }
        const nameNormalized = normalizeCompanyName(name);
        const existing = await companies.findOne({ where: { nameNormalized } });
        if (existing) {
          const claimed = await profiles.findOne({ where: { companyId: existing.id } });
          if (claimed) {
            throw new ConflictException({
              errorCode: 'COMPANY_REVIEW_REQUIRED',
              message: 'This company is already linked to another business account',
            });
          }
          company = existing;
        } else {
          company = await companies.save(
            companies.create({
              name,
              nameNormalized,
              slug: createSlug(name),
              countryCode: input.countryCode ?? 'VN',
              benefits: [],
            }),
          );
        }
        profile = await profiles.save(
          profiles.create({ userId, companyId: company.id, status: 'DRAFT' }),
        );
      } else {
        company = await this.requireCompany(profile.companyId, companies);
      }

      const nextName = input.companyName?.trim();
      const nextWebsite =
        input.website === undefined ? company.website : normalizeNullable(input.website);
      const nextWorkEmail =
        input.workEmail === undefined
          ? profile.workEmail
          : (normalizeNullable(input.workEmail)?.toLowerCase() ?? null);
      const identityChanged =
        (nextName !== undefined && nextName !== company.name) ||
        nextWebsite !== company.website ||
        nextWorkEmail !== profile.workEmailNormalized;

      if (nextName) {
        company.name = nextName;
        company.nameNormalized = normalizeCompanyName(nextName);
      }
      if (input.website !== undefined) company.website = nextWebsite;
      assignCompanyFields(company, input);

      if (input.workEmail !== undefined) {
        profile.workEmail = nextWorkEmail;
        profile.workEmailNormalized = nextWorkEmail;
        profile.workEmailDomain = nextWorkEmail ? emailDomain(nextWorkEmail) : null;
        profile.workEmailVerifiedAt = null;
      }
      if (input.contactName !== undefined)
        profile.contactName = normalizeNullable(input.contactName);
      if (input.contactPhone !== undefined)
        profile.contactPhone = normalizeNullable(input.contactPhone);

      if (identityChanged && !['DRAFT', 'SUSPENDED'].includes(profile.status)) {
        profile.status = 'DRAFT';
        profile.submittedAt = null;
        profile.reviewedAt = null;
        profile.reviewedByUserId = null;
        profile.rejectionReason = null;
        profile.suspensionReason = null;
      }

      company = await companies.save(company);
      profile = await profiles.save(profile);
      return { profile, company: toOwnedCompanyDto(company) };
    });
  }

  async sendWorkEmailVerification(userId: string): Promise<{ accepted: true }> {
    const aggregate = await this.getOwnedEntities(userId);
    if (!aggregate) throw this.profileNotFound();
    const { profile, company } = aggregate;
    if (!profile.workEmailNormalized || !profile.workEmailDomain || !company.website) {
      throw new BadRequestException({
        errorCode: 'WORK_EMAIL_DOMAIN_MISMATCH',
        message: 'Company website and work email are required',
      });
    }
    if (!domainsMatch(company.website, profile.workEmailDomain)) {
      throw new BadRequestException({
        errorCode: 'WORK_EMAIL_DOMAIN_MISMATCH',
        message: 'Work email domain does not match company website',
      });
    }
    const token = randomBytes(32).toString('hex');
    await this.dataSource.transaction(async (manager) => {
      const verifications = manager.getRepository(VerificationEntity);
      await verifications.update(
        { userId, purpose: 'BUSINESS_EMAIL_VERIFY', usedAt: IsNull() },
        { usedAt: new Date() },
      );
      await verifications.save(
        verifications.create({
          userId,
          purpose: 'BUSINESS_EMAIL_VERIFY',
          valueHash: hash(token),
          targetValueHash: hash(profile.workEmailNormalized!),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          usedAt: null,
          attemptCount: 0,
        }),
      );
    });
    const frontend = this.config.get<string>('FRONTEND_BASE_URL') ?? 'http://localhost:8080';
    await this.email.sendVerifyEmail(
      profile.workEmailNormalized,
      `${frontend.replace(/\/$/, '')}/business/verify-email?token=${encodeURIComponent(token)}`,
    );
    return { accepted: true };
  }

  async verifyWorkEmail(token: string): Promise<{ verified: true }> {
    return this.dataSource.transaction(async (manager) => {
      const profiles = manager.getRepository(BusinessProfileEntity);
      const verifications = manager.getRepository(VerificationEntity);
      const verification = await verifications.findOne({
        where: { purpose: 'BUSINESS_EMAIL_VERIFY', valueHash: hash(token) },
        lock: { mode: 'pessimistic_write' },
      });
      const profile = verification
        ? await profiles.findOne({
            where: { userId: verification.userId },
            lock: { mode: 'pessimistic_write' },
          })
        : null;
      if (
        !verification ||
        !profile?.workEmailNormalized ||
        verification.usedAt ||
        verification.expiresAt.getTime() < Date.now() ||
        verification.targetValueHash !== hash(profile.workEmailNormalized)
      ) {
        throw new UnauthorizedException({
          errorCode: 'UNAUTHORIZED',
          message: 'Verification token invalid or expired',
        });
      }
      const now = new Date();
      verification.usedAt = now;
      profile.workEmailVerifiedAt = now;
      await verifications.save(verification);
      await profiles.save(profile);
      return { verified: true };
    });
  }

  async submitMyCompany(userId: string) {
    const aggregate = await this.getOwnedEntities(userId);
    if (!aggregate) throw this.profileNotFound();
    const { profile, company } = aggregate;
    if (profile.status === 'SUSPENDED') {
      throw new ForbiddenException({
        errorCode: 'BUSINESS_NOT_VERIFIED',
        message: 'Suspended business profiles cannot be submitted',
      });
    }
    if (
      !profile.workEmailVerifiedAt ||
      !profile.contactName ||
      !company.name ||
      !company.website ||
      !profile.workEmailDomain ||
      !domainsMatch(company.website, profile.workEmailDomain) ||
      !company.industryCode ||
      !company.shortDescription
    ) {
      throw new BadRequestException({
        errorCode: 'COMPANY_REVIEW_REQUIRED',
        message: 'Complete the company profile and verify the work email before submission',
      });
    }
    profile.status = 'PENDING_REVIEW';
    profile.submittedAt = new Date();
    profile.rejectionReason = null;
    return this.profiles.save(profile);
  }

  async uploadMedia(userId: string, kind: 'logo' | 'cover', file: Express.Multer.File) {
    const aggregate = await this.getOwnedEntities(userId);
    if (!aggregate) throw this.profileNotFound();
    if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)) {
      throw new BadRequestException({
        errorCode: 'UNSUPPORTED_FILE_TYPE',
        message: 'Company media must be PNG, JPEG, or WEBP',
      });
    }
    const oldKey =
      kind === 'logo' ? aggregate.company.logoObjectKey : aggregate.company.coverObjectKey;
    const key = this.storage.buildCompanyMediaObjectKey(
      aggregate.company.id,
      kind,
      file.originalname,
    );
    await this.storage.upload({ key, body: file.buffer, contentType: file.mimetype });
    if (kind === 'logo') aggregate.company.logoObjectKey = key;
    else aggregate.company.coverObjectKey = key;
    await this.companies.save(aggregate.company);
    if (oldKey && oldKey !== key) await this.storage.delete(oldKey).catch(() => undefined);
    return { kind, url: `/api/business/company/${kind}` };
  }

  async downloadMyMedia(userId: string, kind: 'logo' | 'cover'): Promise<DownloadedFile> {
    const aggregate = await this.getOwnedEntities(userId);
    if (!aggregate) throw this.profileNotFound();
    return this.downloadMediaEntity(aggregate.company, kind);
  }

  async downloadAdminMedia(profileId: string, kind: 'logo' | 'cover'): Promise<DownloadedFile> {
    const aggregate = await this.getAdminEntities(profileId);
    return this.downloadMediaEntity(aggregate.company, kind);
  }

  async downloadPublicMedia(slug: string, kind: 'logo' | 'cover'): Promise<DownloadedFile> {
    const company = await this.requirePublicCompanyEntity(slug);
    const key = kind === 'logo' ? company.logoObjectKey : company.coverObjectKey;
    if (!key) throw new NotFoundException('Company media not found');
    return this.storage.download(key);
  }

  async listAdmin(status?: BusinessProfileStatus, page = 1, limit = 20) {
    const take = Math.min(Math.max(limit, 1), 100);
    const [items, total] = await this.profiles.findAndCount({
      where: status ? { status } : {},
      order: { createdAt: 'DESC' },
      skip: (Math.max(page, 1) - 1) * take,
      take,
    });
    return { items, total, page: Math.max(page, 1), limit: take };
  }

  async getAdmin(profileId: string) {
    const aggregate = await this.getAdminEntities(profileId);
    return {
      profile: aggregate.profile,
      company: toAdminCompanyDto(aggregate.company, profileId),
    };
  }

  async getPublicCompany(slug: string) {
    const company = await this.requirePublicCompanyEntity(slug);
    return {
      id: company.id,
      slug: company.slug,
      name: company.name,
      website: company.website,
      linkedinUrl: company.linkedinUrl,
      industryCode: company.industryCode,
      companyType: company.companyType,
      companySize: company.companySize,
      foundedYear: company.foundedYear,
      countryCode: company.countryCode,
      headquartersCityCode: company.headquartersCityCode,
      headquartersAddress: company.headquartersAddress,
      shortDescription: company.shortDescription,
      description: company.description,
      cultureDescription: company.cultureDescription,
      benefits: company.benefits,
      logoUrl: company.logoObjectKey ? `/api/companies/${company.slug}/logo` : null,
      coverUrl: company.coverObjectKey ? `/api/companies/${company.slug}/cover` : null,
    };
  }

  private async requirePublicCompanyEntity(slug: string): Promise<CompanyEntity> {
    const company = await this.companies.findOne({ where: { slug } });
    if (!company) throw new NotFoundException('Company not found');
    const profile = await this.profiles.findOne({
      where: { companyId: company.id, status: 'VERIFIED' },
    });
    if (!profile) throw new NotFoundException('Company not found');
    return company;
  }

  private async getOwnedEntities(
    userId: string,
  ): Promise<{ profile: BusinessProfileEntity; company: CompanyEntity } | null> {
    const profile = await this.profiles.findOne({ where: { userId } });
    if (!profile) return null;
    return { profile, company: await this.requireCompany(profile.companyId) };
  }

  private async getAdminEntities(
    profileId: string,
  ): Promise<{ profile: BusinessProfileEntity; company: CompanyEntity }> {
    const profile = await this.profiles.findOne({ where: { id: profileId } });
    if (!profile) throw this.profileNotFound();
    return { profile, company: await this.requireCompany(profile.companyId) };
  }

  private downloadMediaEntity(
    company: CompanyEntity,
    kind: 'logo' | 'cover',
  ): Promise<DownloadedFile> {
    const key = kind === 'logo' ? company.logoObjectKey : company.coverObjectKey;
    if (!key) throw new NotFoundException('Company media not found');
    return this.storage.download(key);
  }

  private async requireCompany(
    companyId: string,
    companies: Repository<CompanyEntity> = this.companies,
  ): Promise<CompanyEntity> {
    const company = await companies.findOne({ where: { id: companyId } });
    if (!company) throw new NotFoundException('Company not found');
    return company;
  }

  private profileNotFound(): NotFoundException {
    return new NotFoundException({
      errorCode: 'BUSINESS_PROFILE_NOT_FOUND',
      message: 'Business profile not found',
    });
  }
}

export function domainsMatch(website: string, emailHost: string): boolean {
  try {
    const websiteHost = new URL(website).hostname.toLowerCase().replace(/^www\./, '');
    const mailHost = emailHost.toLowerCase().replace(/^www\./, '');
    return (
      websiteHost === mailHost ||
      websiteHost.endsWith(`.${mailHost}`) ||
      mailHost.endsWith(`.${websiteHost}`)
    );
  } catch {
    return false;
  }
}

function assignCompanyFields(company: CompanyEntity, input: UpdateCompanyInput): void {
  const keys: Array<[keyof UpdateCompanyInput, keyof CompanyEntity]> = [
    ['linkedinUrl', 'linkedinUrl'],
    ['industryCode', 'industryCode'],
    ['companyType', 'companyType'],
    ['companySize', 'companySize'],
    ['foundedYear', 'foundedYear'],
    ['countryCode', 'countryCode'],
    ['headquartersCityCode', 'headquartersCityCode'],
    ['headquartersAddress', 'headquartersAddress'],
    ['shortDescription', 'shortDescription'],
    ['description', 'description'],
    ['cultureDescription', 'cultureDescription'],
    ['benefits', 'benefits'],
  ];
  for (const [source, target] of keys) {
    if (input[source] !== undefined)
      (company as unknown as Record<string, unknown>)[target] = input[source];
  }
}

function normalizeNullable(value: string | null): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeCompanyName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function createSlug(value: string): string {
  const base = normalizeCompanyName(value).replace(/\s+/g, '-').slice(0, 240) || 'company';
  return `${base}-${randomBytes(4).toString('hex')}`;
}

function emailDomain(value: string): string {
  const domain = value.split('@')[1]?.toLowerCase();
  if (!domain)
    throw new BadRequestException({ errorCode: 'VALIDATION_ERROR', message: 'Invalid work email' });
  return domain;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function toOwnedCompanyDto(company: CompanyEntity) {
  const { logoObjectKey, coverObjectKey, ...publicFields } = company;
  return {
    ...publicFields,
    logoUrl: logoObjectKey ? '/api/business/company/logo' : null,
    coverUrl: coverObjectKey ? '/api/business/company/cover' : null,
  };
}

function toAdminCompanyDto(company: CompanyEntity, profileId: string) {
  const { logoObjectKey, coverObjectKey, ...publicFields } = company;
  return {
    ...publicFields,
    logoUrl: logoObjectKey ? `/api/admin/business-profiles/${profileId}/logo` : null,
    coverUrl: coverObjectKey ? `/api/admin/business-profiles/${profileId}/cover` : null,
  };
}

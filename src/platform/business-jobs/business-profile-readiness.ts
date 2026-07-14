import type {
  BusinessProfileEntity,
  BusinessProfileStatus,
} from '../../database/entities/business-profile.entity';
import type { CompanyEntity } from '../../database/entities/company.entity';

export type BusinessProfileBlocker =
  | 'PROFILE_SUSPENDED'
  | 'WORK_EMAIL_UNVERIFIED'
  | 'CONTACT_NAME_MISSING'
  | 'COMPANY_NAME_MISSING'
  | 'WEBSITE_MISSING'
  | 'WORK_EMAIL_DOMAIN_MISMATCH'
  | 'INDUSTRY_MISSING'
  | 'SHORT_DESCRIPTION_MISSING';

type ReadinessProfile = Pick<
  BusinessProfileEntity,
  'status' | 'contactName' | 'workEmailDomain' | 'workEmailVerifiedAt'
>;
type ReadinessCompany = Pick<
  CompanyEntity,
  'name' | 'website' | 'industryCode' | 'shortDescription'
>;

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

export function businessProfileBlockers(
  profile: ReadinessProfile,
  company: ReadinessCompany,
): BusinessProfileBlocker[] {
  const blockers: BusinessProfileBlocker[] = [];
  if (profile.status === 'SUSPENDED') blockers.push('PROFILE_SUSPENDED');
  if (!profile.workEmailVerifiedAt) blockers.push('WORK_EMAIL_UNVERIFIED');
  if (!profile.contactName?.trim()) blockers.push('CONTACT_NAME_MISSING');
  if (!company.name?.trim()) blockers.push('COMPANY_NAME_MISSING');
  if (!company.website?.trim()) blockers.push('WEBSITE_MISSING');
  if (
    company.website &&
    (!profile.workEmailDomain || !domainsMatch(company.website, profile.workEmailDomain))
  ) {
    blockers.push('WORK_EMAIL_DOMAIN_MISMATCH');
  }
  if (!company.industryCode?.trim()) blockers.push('INDUSTRY_MISSING');
  if (!company.shortDescription?.trim()) blockers.push('SHORT_DESCRIPTION_MISSING');
  return blockers;
}

export function canPublishJobs(status: BusinessProfileStatus): boolean {
  return status === 'VERIFIED';
}

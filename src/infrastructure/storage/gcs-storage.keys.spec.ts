import { GcsStorageService } from './gcs-storage.service';

describe('GcsStorageService business job keys', () => {
  const storage = Object.create(GcsStorageService.prototype) as GcsStorageService;

  it('isolates immutable application CV snapshots from source CV objects', () => {
    expect(storage.buildApplicationCvObjectKey('application-1', 'My CV.pdf')).toBe(
      'job-applications/application-1/My-CV.pdf',
    );
  });

  it('stores company media under the owning company', () => {
    expect(storage.buildCompanyMediaObjectKey('company-1', 'logo', 'logo image.png')).toBe(
      'companies/company-1/logo/logo-image.png',
    );
  });
});

import { configValidationSchema } from './validation';

// Minimal env that satisfies the required keys so we can assert OPTIONAL defaults in isolation.
const base = {
  NODE_ENV: 'test',
  INTERNAL_AUTH_SECRET: 'x'.repeat(16),
  DATABASE_URL: 'postgres://localhost:5432/db',
};

describe('configValidationSchema — OCR fallback defaults', () => {
  it('applies safe OCR_FALLBACK_* defaults when unset', () => {
    const { error, value } = configValidationSchema.validate(base, { allowUnknown: true });
    expect(error).toBeUndefined();
    expect(value.OCR_FALLBACK_ENABLED).toBe(true);
    expect(value.OCR_FALLBACK_MAX_PAGES).toBe(3);
    expect(value.OCR_FALLBACK_TIMEOUT_MS).toBe(25000);
    expect(value.OCR_FALLBACK_MAX_PDF_BYTES).toBe(10485760);
    expect(value.OCR_FALLBACK_DPI).toBe(200);
  });

  it('coerces + accepts overrides', () => {
    const { error, value } = configValidationSchema.validate(
      { ...base, OCR_FALLBACK_ENABLED: 'false', OCR_FALLBACK_MAX_PAGES: '5' },
      { allowUnknown: true },
    );
    expect(error).toBeUndefined();
    expect(value.OCR_FALLBACK_ENABLED).toBe(false);
    expect(value.OCR_FALLBACK_MAX_PAGES).toBe(5);
  });

  it('rejects out-of-range values (NaN-safe via Joi)', () => {
    const { error } = configValidationSchema.validate(
      { ...base, OCR_FALLBACK_MAX_PAGES: 'garbage' },
      { allowUnknown: true },
    );
    expect(error).toBeDefined();
  });
});

describe('configValidationSchema — CV_JD_MATCH_TEMPLATE_CODE', () => {
  it('defaults to cv_jd_match_v1 when unset (safe baseline; flip is a deliberate change)', () => {
    const { error, value } = configValidationSchema.validate(base, { allowUnknown: true });
    expect(error).toBeUndefined();
    expect(value.CV_JD_MATCH_TEMPLATE_CODE).toBe('cv_jd_match_v1');
  });

  it('accepts cv_jd_match_v2', () => {
    const { error, value } = configValidationSchema.validate(
      { ...base, CV_JD_MATCH_TEMPLATE_CODE: 'cv_jd_match_v2' },
      { allowUnknown: true },
    );
    expect(error).toBeUndefined();
    expect(value.CV_JD_MATCH_TEMPLATE_CODE).toBe('cv_jd_match_v2');
  });

  it('rejects an unknown template code', () => {
    const { error } = configValidationSchema.validate(
      { ...base, CV_JD_MATCH_TEMPLATE_CODE: 'cv_jd_match_v3' },
      { allowUnknown: true },
    );
    expect(error).toBeDefined();
  });
});

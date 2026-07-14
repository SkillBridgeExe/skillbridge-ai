import { assertNotAccidentalProdDb, isDeliberateProdOverride } from './prod-db-guard';

const PROD_URL =
  'postgresql://postgres.uvwbnezbgcyktkcmfztb:pw@aws-1-ap-southeast-2.pooler.supabase.com:5432/postgres';
const LOCAL_URL = 'postgresql://postgres:pw@localhost:5432/skillbridge';

describe('assertNotAccidentalProdDb', () => {
  it('allows an empty / missing URL', () => {
    expect(() => assertNotAccidentalProdDb(undefined, {})).not.toThrow();
    expect(() => assertNotAccidentalProdDb('', {})).not.toThrow();
  });

  it('allows a local/dev URL', () => {
    expect(() => assertNotAccidentalProdDb(LOCAL_URL, {})).not.toThrow();
  });

  it('allows the prod URL on Cloud Run (K_SERVICE set by the platform)', () => {
    expect(() =>
      assertNotAccidentalProdDb(PROD_URL, { K_SERVICE: 'skillbridge-be' }),
    ).not.toThrow();
  });

  it('allows the prod URL under NODE_ENV=test (DB-less boots, jest on dev machines)', () => {
    expect(() => assertNotAccidentalProdDb(PROD_URL, { NODE_ENV: 'test' })).not.toThrow();
  });

  it('allows the prod URL with the explicit ALLOW_PROD_DB=1 opt-in', () => {
    expect(() => assertNotAccidentalProdDb(PROD_URL, { ALLOW_PROD_DB: '1' })).not.toThrow();
  });

  it('THROWS on the prod URL from a plain local run (the 2026-07-10 incident shape)', () => {
    expect(() => assertNotAccidentalProdDb(PROD_URL, {})).toThrow(/PRODUCTION database/);
  });

  it('matches the prod marker in the direct-host form too', () => {
    const direct = 'postgresql://postgres:pw@db.uvwbnezbgcyktkcmfztb.supabase.co:5432/postgres';
    expect(() => assertNotAccidentalProdDb(direct, {})).toThrow(/PRODUCTION database/);
  });

  it('ALLOW_PROD_DB must be exactly "1"', () => {
    expect(() => assertNotAccidentalProdDb(PROD_URL, { ALLOW_PROD_DB: 'true' })).toThrow();
    expect(isDeliberateProdOverride({ ALLOW_PROD_DB: '1' })).toBe(true);
    expect(isDeliberateProdOverride({})).toBe(false);
  });
});

import { createToolDbClient } from '../../src/tools/tool-db-client';
import { assertNotAccidentalProdDb } from '../../src/database/prod-db-guard';
import { Client } from 'pg';

jest.mock('pg', () => ({
  Client: jest.fn(),
}));

jest.mock('../../src/database/prod-db-guard', () => ({
  assertNotAccidentalProdDb: jest.fn(),
}));

describe('createToolDbClient', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('throws an error if DATABASE_URL is not set', () => {
    delete process.env.DATABASE_URL;
    expect(() => createToolDbClient()).toThrow('DATABASE_URL is not set');
  });

  it('calls assertNotAccidentalProdDb with the provided DATABASE_URL', () => {
    process.env.DATABASE_URL = 'postgres://local:5432/db';
    createToolDbClient();
    expect(assertNotAccidentalProdDb).toHaveBeenCalledWith('postgres://local:5432/db');
  });

  it('creates a Client with ssl true if DB_SSL is "true"', () => {
    process.env.DATABASE_URL = 'postgres://local:5432/db';
    process.env.DB_SSL = 'true';

    createToolDbClient();

    expect(Client).toHaveBeenCalledWith({
      connectionString: 'postgres://local:5432/db',
      ssl: { rejectUnauthorized: false },
    });
  });

  it('creates a Client with no ssl config if DB_SSL is missing', () => {
    process.env.DATABASE_URL = 'postgres://local:5432/db';
    delete process.env.DB_SSL;

    createToolDbClient();

    expect(Client).toHaveBeenCalledWith({
      connectionString: 'postgres://local:5432/db',
      ssl: undefined,
    });
  });
});

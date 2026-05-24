import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

/**
 * Thin Postgres wrapper around pg.Pool.
 *
 * Usage patterns:
 *
 *   // Simple parameterised query:
 *   const rows = await db.query<MyRow>('SELECT * FROM ai_jobs WHERE id = $1', [id]);
 *
 *   // Transaction:
 *   await db.transaction(async (client) => {
 *     await client.query('INSERT INTO ai_requests ...');
 *     await client.query('INSERT INTO ai_results ...');
 *   });
 *
 * Note: prefer specific repository services in feature modules over calling
 * this directly from controllers/services. This is the low-level driver.
 */
@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private pool!: Pool;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const url = this.config.get<string>('database.url');
    if (!url) {
      this.logger.warn('DATABASE_URL is empty; DatabaseService is disabled.');
      return;
    }

    this.pool = new Pool({
      connectionString: url,
      max: 10,
      idleTimeoutMillis: 30_000,
    });

    try {
      const client = await this.pool.connect();
      await client.query('SELECT 1');
      client.release();
      this.logger.log('Connected to Postgres.');
    } catch (err) {
      this.logger.error(`Failed to connect to Postgres: ${(err as Error).message}`);
      throw err;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.logger.log('Postgres pool closed.');
    }
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const result: QueryResult<T> = await this.pool.query<T>(sql, params);
    return result.rows;
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  getPool(): Pool {
    return this.pool;
  }
}

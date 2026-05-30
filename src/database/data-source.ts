import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from './orm.config';

/**
 * Standalone DataSource for the TypeORM CLI (migration:generate / migration:run).
 * Reads env directly because the CLI runs outside the Nest DI container.
 *
 * App runtime will use `TypeOrmModule.forRootAsync` (same options builder) once
 * wired into a DatabaseModule — see ARCHITECTURE.md §7.
 *
 *   npm run migration:generate -- src/database/migrations/Init
 *   npm run migration:run
 */
export default new DataSource(buildDataSourceOptions());

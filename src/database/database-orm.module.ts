import { DynamicModule, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { buildDataSourceOptions } from './orm.config';

/**
 * Wires TypeORM into the app — but ONLY outside the test env.
 *
 * The e2e suite runs with NODE_ENV=test and no real Postgres (see
 * test/setup-e2e.ts), so we skip the root connection there to keep build/e2e
 * green without a DB. Real runs (development/production) connect normally.
 *
 * TODO(R0): once `docker compose up postgres` is wired into the e2e setup (or a
 * test DB is provided), drop the NODE_ENV guard so e2e exercises real queries.
 */
@Module({})
export class DatabaseOrmModule {
  static forRoot(): DynamicModule {
    if (process.env.NODE_ENV === 'test') {
      return { module: DatabaseOrmModule };
    }
    return {
      module: DatabaseOrmModule,
      imports: [
        TypeOrmModule.forRootAsync({
          inject: [ConfigService],
          useFactory: () => ({
            ...buildDataSourceOptions(),
            autoLoadEntities: true,
            // Apply pending migrations on boot so a deploy actually ships its schema
            // changes. Previously `start:prod` was `node dist/main` with no migration
            // step, so a merged migration (e.g. chat_conversations.cv_id) never reached
            // prod until run by hand — every diagnosis-chat call 500'd until then.
            // `synchronize` stays false: migrations remain the source of truth. TypeORM
            // wraps each migration in a transaction and records it, so on a multi-instance
            // Cloud Run rollout only the first post-deploy boot has anything to run.
            migrationsRun: true,
          }),
        }),
      ],
    };
  }
}

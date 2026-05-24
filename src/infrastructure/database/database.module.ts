import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service';

/**
 * Global Postgres connection.
 *
 * NestJS has WRITE access only to AI tables:
 *   ai_jobs, ai_requests, ai_results,
 *   documents, document_chunks, embedding_jobs,
 *   retrieval_logs, ai_tool_calls
 *
 * Other tables are read-only.
 */
@Global()
@Module({
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule {}

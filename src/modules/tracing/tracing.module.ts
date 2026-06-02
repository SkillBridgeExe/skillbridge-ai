import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiRequestEntity } from '../../database/entities/ai-request.entity';
import { AiResultEntity } from '../../database/entities/ai-result.entity';
import { TracingService } from './tracing.service';

const TRACING_IMPORTS =
  process.env.NODE_ENV === 'test'
    ? []
    : [TypeOrmModule.forFeature([AiRequestEntity, AiResultEntity])];

/**
 * Writes traceability records to the DB:
 *   - ai_jobs
 *   - ai_requests (every LLM call)
 *   - ai_results
 *   - retrieval_logs (every RAG retrieval)
 *   - ai_tool_calls (every MCP/tool execution)
 *
 * Tracing is FIRST-CLASS — the AI/RAG/MCP demo evidence depends on this data.
 */
@Global()
@Module({
  imports: TRACING_IMPORTS,
  providers: [TracingService],
  exports: [TracingService],
})
export class TracingModule {}

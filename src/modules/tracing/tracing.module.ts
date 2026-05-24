import { Global, Module } from '@nestjs/common';
import { TracingService } from './tracing.service';

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
  providers: [TracingService],
  exports: [TracingService],
})
export class TracingModule {}

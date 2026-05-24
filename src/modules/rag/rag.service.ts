import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../../infrastructure/llm/llm.service';
import { PgVectorService } from '../../infrastructure/vector/pgvector.service';
import { TracingService } from '../tracing/tracing.service';
import { RagQueryRequestDto, RagQueryResponseDto } from './dto/rag-query.dto';

@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);

  constructor(
    private readonly llm: LlmService,
    private readonly vector: PgVectorService,
    private readonly tracing: TracingService,
  ) {}

  async query(
    userId: string,
    aiRequestId: string | undefined,
    input: RagQueryRequestDto,
  ): Promise<RagQueryResponseDto> {
    // 1) Embed the query text
    const embedded = await this.llm.embed(input.query_text);

    // 2) Vector search
    const results = await this.vector.search(embedded.embedding, {
      topK: input.top_k,
      filter: input.filter,
    });

    // 3) Log the retrieval for traceability
    const retrievalLogId = await this.tracing.logRetrieval({
      aiRequestId,
      userId,
      queryText: input.query_text,
      topK: input.top_k,
      retrievedChunks: results,
    });

    return {
      retrieval_log_id: retrievalLogId,
      chunks: results.map((r) => ({
        chunk_id: r.chunkId,
        document_id: r.documentId,
        content: r.content,
        score: r.score,
        metadata: r.metadata,
      })),
    };
  }
}

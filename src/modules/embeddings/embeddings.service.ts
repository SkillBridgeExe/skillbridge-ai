import { Injectable, Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { LlmService } from '../../infrastructure/llm/llm.service';
import { PgVectorService } from '../../infrastructure/vector/pgvector.service';
import { ChunkerService } from './chunker.service';
import { IndexDocumentRequestDto, IndexDocumentResponseDto } from './dto/index-document.dto';

@Injectable()
export class EmbeddingsService {
  private readonly logger = new Logger(EmbeddingsService.name);

  constructor(
    private readonly chunker: ChunkerService,
    private readonly llm: LlmService,
    private readonly vector: PgVectorService,
  ) {}

  async indexDocument(
    userId: string,
    correlationId: string,
    input: IndexDocumentRequestDto,
  ): Promise<IndexDocumentResponseDto> {
    this.logger.log(
      `Indexing document ${input.document_id} (${input.source_type}) [cid=${correlationId}]`,
    );

    const chunks = this.chunker.chunk(input.content);
    if (chunks.length === 0) {
      return {
        document_id: input.document_id,
        embedding_job_id: uuidv4(),
        chunks_count: 0,
        vector_document_id: null,
        status: 'SUCCESS',
      };
    }

    // TODO: persist document_chunks rows + embedding_jobs row via DB once schema is migrated.
    // For now, just compute embeddings to verify the LLM path works end-to-end.
    for (const chunk of chunks) {
      try {
        const embedded = await this.llm.embed(chunk.content);
        await this.vector.upsertChunkEmbedding(uuidv4(), embedded.embedding);
      } catch (err) {
        this.logger.warn(`Embedding failed for chunk #${chunk.index}: ${(err as Error).message}`);
      }
    }

    return {
      document_id: input.document_id,
      embedding_job_id: uuidv4(),
      chunks_count: chunks.length,
      vector_document_id: null,
      status: 'SUCCESS',
    };
  }
}

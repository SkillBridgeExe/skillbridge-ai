import { Body, Controller, Post } from '@nestjs/common';
import { CorrelationId } from '../../common/decorators/correlation-id.decorator';
import { InternalUser } from '../../common/decorators/internal-user.decorator';
import {
  IndexDocumentRequestDto,
  IndexDocumentResponseDto,
} from './dto/index-document.dto';
import { EmbeddingsService } from './embeddings.service';

@Controller('internal/ai/embeddings')
export class EmbeddingsController {
  constructor(private readonly service: EmbeddingsService) {}

  /**
   * POST /internal/ai/embeddings/index
   *
   * Chunks the document, embeds each chunk, stores them in document_chunks
   * with vector embeddings for later RAG retrieval.
   */
  @Post('index')
  async indexDocument(
    @InternalUser() userId: string,
    @CorrelationId() correlationId: string,
    @Body() body: IndexDocumentRequestDto,
  ): Promise<IndexDocumentResponseDto> {
    return this.service.indexDocument(userId, correlationId, body);
  }
}

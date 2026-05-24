import { Body, Controller, Post } from '@nestjs/common';
import { CorrelationId } from '../../common/decorators/correlation-id.decorator';
import { InternalUser } from '../../common/decorators/internal-user.decorator';
import { RagQueryRequestDto, RagQueryResponseDto } from './dto/rag-query.dto';
import { RagService } from './rag.service';

@Controller('internal/ai/rag')
export class RagController {
  constructor(private readonly service: RagService) {}

  /**
   * POST /internal/ai/rag/query
   *
   * Internal retrieval helper. Mostly used by other NestJS modules,
   * but exposed for admin debugging and integration testing.
   */
  @Post('query')
  async query(
    @InternalUser() userId: string,
    @CorrelationId() _correlationId: string,
    @Body() body: RagQueryRequestDto,
  ): Promise<RagQueryResponseDto> {
    return this.service.query(userId, undefined, body);
  }
}

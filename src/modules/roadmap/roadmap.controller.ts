import { Body, Controller, Post } from '@nestjs/common';
import { CorrelationId } from '../../common/decorators/correlation-id.decorator';
import { InternalUser } from '../../common/decorators/internal-user.decorator';
import { RoadmapGenerateRequestDto } from './dto/roadmap-request.dto';
import { RoadmapGenerateResponseDto } from './dto/roadmap-response.dto';
import { RoadmapService } from './roadmap.service';

@Controller('internal/ai/roadmap')
export class RoadmapController {
  constructor(private readonly service: RoadmapService) {}

  /**
   * POST /internal/ai/roadmap/generate
   *
   * RAG-based learning roadmap generation:
   *   - Pulls relevant course chunks from documents
   *   - Feeds CV + JD + retrieved context into the LLM
   *   - Returns structured steps + AI advice
   */
  @Post('generate')
  generate(
    @InternalUser() userId: string,
    @CorrelationId() _cid: string,
    @Body() body: RoadmapGenerateRequestDto,
  ): Promise<RoadmapGenerateResponseDto> {
    return this.service.generate(userId, body);
  }
}

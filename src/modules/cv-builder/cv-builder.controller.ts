import { Body, Controller, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InternalUser } from '../../common/decorators/internal-user.decorator';
import { EvaluateSectionRequestDto, EvaluateSectionResponseDto } from './dto/evaluate-section.dto';
import { RewriteRequestDto, RewriteResponseDto } from './dto/rewrite.dto';
import { SectionEvaluatorService } from './section-evaluator.service';
import { CvRewriteService } from './cv-rewrite.service';

/**
 * R1b CV-Builder AI brain — INTERNAL endpoints (X-Internal-Auth via the global guard).
 * The platform layer (`/api/cvs/:id/builder/*`, Tuấn) wraps these for the FE. STATELESS:
 * no draft is owned here — input in, result out (spec §7A).
 */
@ApiTags('cv-builder')
@Controller('internal/ai/cv')
export class CvBuilderController {
  constructor(
    private readonly evaluator: SectionEvaluatorService,
    private readonly rewriter: CvRewriteService,
  ) {}

  @Post('evaluate-section')
  @ApiOperation({ summary: 'Deterministic per-section CV score + ✅/❌ checklist + missing hints' })
  evaluateSection(@Body() body: EvaluateSectionRequestDto): EvaluateSectionResponseDto {
    return this.evaluator.evaluate(body);
  }

  @Post('rewrite')
  @ApiOperation({
    summary: 'AI rewrite one field (harvard/translate/custom) — no fabrication guardrail',
  })
  rewrite(
    @Body() body: RewriteRequestDto,
    @InternalUser() userId: string,
  ): Promise<RewriteResponseDto> {
    // No verifiedAction is passed here, so mode='tailor' fails closed (NO_VERIFIED_ACTION):
    // tailoring requires the platform path (/api/cvs/:id/builder/rewrite) which reloads the match,
    // verifies ownership + the action, and supplies the trusted action. This endpoint stays
    // harvard/translate/custom only.
    return this.rewriter.rewrite(body, userId);
  }
}

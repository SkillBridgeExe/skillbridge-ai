import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, JwtUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import {
  CreateLearningRoadmapDraftDto,
  LearningRoadmapGenerateDto,
  UpdateLearningRoadmapDraftDto,
} from './dto/roadmap.dto';
import { LearningRoadmapDraftService } from './roadmap-draft.service';
import { LearningRoadmapGenerationService } from './roadmap-generation.service';
import { LearningRoadmapQueryService } from './roadmap-query.service';

@ApiTags('Learning Roadmaps')
@Public()
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('api/learning/roadmaps')
export class LearningRoadmapsController {
  constructor(
    private readonly drafts: LearningRoadmapDraftService,
    private readonly generation: LearningRoadmapGenerationService,
    private readonly queries: LearningRoadmapQueryService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a server-owned Learning V2 roadmap draft' })
  create(@CurrentUser() user: JwtUser, @Body() dto: CreateLearningRoadmapDraftDto) {
    return this.drafts.createDraft(user.userId, dto);
  }

  @Patch(':roadmapId/draft')
  @ApiOperation({ summary: 'Update priorities and schedule with optimistic concurrency' })
  update(
    @CurrentUser() user: JwtUser,
    @Param('roadmapId') roadmapId: string,
    @Body() dto: UpdateLearningRoadmapDraftDto,
  ) {
    return this.drafts.updateDraft(user.userId, roadmapId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List roadmaps owned by the current learner' })
  list(@CurrentUser() user: JwtUser) {
    return this.drafts.list(user.userId);
  }

  @Get(':roadmapId')
  @ApiOperation({ summary: 'Get an owned active roadmap with dated runtime sessions' })
  getActive(@CurrentUser() user: JwtUser, @Param('roadmapId') roadmapId: string) {
    return this.queries.getActive(user.userId, roadmapId);
  }

  @Post(':roadmapId/preview')
  @ApiOperation({ summary: 'Preview feasibility and dated sessions without consuming quota' })
  preview(
    @CurrentUser() user: JwtUser,
    @Param('roadmapId') roadmapId: string,
    @Body() dto: LearningRoadmapGenerateDto,
  ) {
    return this.generation.preview(user.userId, roadmapId, dto.expected_revision);
  }

  @Post(':roadmapId/generate')
  @ApiOperation({ summary: 'Generate and atomically persist an immutable roadmap version' })
  generate(
    @CurrentUser() user: JwtUser,
    @Param('roadmapId') roadmapId: string,
    @Body() dto: LearningRoadmapGenerateDto,
  ) {
    return this.generation.generate(user.userId, roadmapId, dto.expected_revision);
  }
}

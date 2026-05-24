import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../../infrastructure/llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';
import { TracingService } from '../tracing/tracing.service';
import { RagService } from '../rag/rag.service';
import { RoadmapGenerateRequestDto } from './dto/roadmap-request.dto';
import {
  RoadmapGenerateResponseDto,
  RoadmapParsedResponse,
} from './dto/roadmap-response.dto';

@Injectable()
export class RoadmapService {
  private readonly logger = new Logger(RoadmapService.name);

  constructor(
    private readonly llm: LlmService,
    private readonly prompts: PromptsService,
    private readonly tracing: TracingService,
    private readonly rag: RagService,
  ) {}

  async generate(
    userId: string,
    input: RoadmapGenerateRequestDto,
  ): Promise<RoadmapGenerateResponseDto> {
    const template = this.prompts.get(input.prompt_template_code);
    const userPrompt = this.prompts.render(input.prompt_template_code, {
      cv_text: input.cv_text,
      jd_text: input.jd_text ?? '(no JD provided)',
      target_role: input.target_role,
      hours_per_week: input.hours_per_week,
      user_profile: input.user_profile ?? {},
    });

    const aiRequestId = await this.tracing.startAiRequest({
      userId,
      modelCode: '',
      promptTemplateCode: template.code,
      promptTemplateVersion: template.version,
      requestType: 'roadmap_generate',
      requestPayload: { target_role: input.target_role, hours_per_week: input.hours_per_week },
    });

    const llmResult = await this.llm.complete(
      [
        { role: 'system', content: template.meta.system ?? '' },
        { role: 'user', content: userPrompt },
      ],
      { jsonMode: true, temperature: 0.3, maxOutputTokens: 3500 },
    );

    await this.tracing.completeAiRequest(aiRequestId, {
      promptTokens: llmResult.tokenUsage.promptTokens,
      completionTokens: llmResult.tokenUsage.completionTokens,
      totalTokens: llmResult.tokenUsage.totalTokens,
      latencyMs: llmResult.latencyMs,
      status: 'SUCCESS',
    });

    const parsed = (llmResult.parsedJson ?? {
      title: '',
      total_weeks: 0,
      ai_summary: '',
      ai_advice: '',
      steps: [],
    }) as RoadmapParsedResponse;

    await this.tracing.saveAiResult({
      aiRequestId,
      userId,
      resultType: 'roadmap_generate',
      rawResponse: llmResult.rawResponse,
      parsedResponse: parsed,
      tokenUsage: llmResult.tokenUsage.totalTokens,
    });

    return {
      ai_request_id: aiRequestId,
      parsed_response: parsed,
      retrieval_log_id: null,
      retrieved_chunks_count: 0,
      token_usage: llmResult.tokenUsage.totalTokens,
    };
  }
}

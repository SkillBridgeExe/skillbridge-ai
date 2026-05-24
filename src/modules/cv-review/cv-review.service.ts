import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../../infrastructure/llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';
import { TracingService } from '../tracing/tracing.service';
import { CvReviewRequestDto } from './dto/cv-review-request.dto';
import { CvReviewResponseDto } from './dto/cv-review-response.dto';
import { CvReviewParser } from './cv-review.parser';

@Injectable()
export class CvReviewService {
  private readonly logger = new Logger(CvReviewService.name);

  constructor(
    private readonly llm: LlmService,
    private readonly prompts: PromptsService,
    private readonly tracing: TracingService,
    private readonly parser: CvReviewParser,
  ) {}

  async review(userId: string, input: CvReviewRequestDto): Promise<CvReviewResponseDto> {
    const template = this.prompts.get(input.prompt_template_code);
    const userPrompt = this.prompts.render(input.prompt_template_code, {
      cv_text: input.parsed_text,
    });

    const aiRequestId = await this.tracing.startAiRequest({
      userId,
      modelCode: '', // filled after LLM call
      promptTemplateCode: template.code,
      promptTemplateVersion: template.version,
      requestType: 'cv_review',
      requestPayload: { cv_id: input.cv_id, prompt_template_code: input.prompt_template_code },
    });

    const llmResult = await this.llm.complete(
      [
        { role: 'system', content: template.meta.system ?? '' },
        { role: 'user', content: userPrompt },
      ],
      { jsonMode: true, temperature: 0.2, maxOutputTokens: 2048 },
    );

    await this.tracing.completeAiRequest(aiRequestId, {
      promptTokens: llmResult.tokenUsage.promptTokens,
      completionTokens: llmResult.tokenUsage.completionTokens,
      totalTokens: llmResult.tokenUsage.totalTokens,
      latencyMs: llmResult.latencyMs,
      status: 'SUCCESS',
    });

    const parsed = this.parser.parse(llmResult.parsedJson);

    await this.tracing.saveAiResult({
      aiRequestId,
      userId,
      resultType: 'cv_review',
      rawResponse: llmResult.rawResponse,
      parsedResponse: parsed,
      totalScore: parsed.overall_score,
      tokenUsage: llmResult.tokenUsage.totalTokens,
    });

    return {
      ai_request_id: aiRequestId,
      result_type: 'cv_review',
      raw_response: llmResult.rawResponse,
      parsed_response: parsed,
      total_score: parsed.overall_score,
      confidence_score: 0.85,
      token_usage: llmResult.tokenUsage.totalTokens,
      model_code: llmResult.modelCode,
      latency_ms: llmResult.latencyMs,
      prompt_template_version: template.version,
    };
  }
}

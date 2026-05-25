import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../../infrastructure/llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';
import { TracingService } from '../tracing/tracing.service';
import { RagService } from '../rag/rag.service';
import { CvJdMatchRequestDto } from './dto/cv-jd-match-request.dto';
import { CvJdMatchParsedResponse, CvJdMatchResponseDto } from './dto/cv-jd-match-response.dto';

/**
 * Composite scoring:
 *   - semantic_score:    cosine similarity between CV and JD embeddings
 *   - ats_score:         keyword overlap (rule engine)
 *   - llm_score:         LLM judgement
 *   - rule_engine_score: weighted rules (years, education, role match)
 *   - overall_score:     weighted combo of the above
 *
 * MVP scaffold: returns LLM-only scoring. Sub-scorers can be added incrementally.
 */
@Injectable()
export class CvJdMatchService {
  private readonly logger = new Logger(CvJdMatchService.name);

  constructor(
    private readonly llm: LlmService,
    private readonly prompts: PromptsService,
    private readonly tracing: TracingService,
    private readonly rag: RagService,
  ) {}

  async match(userId: string, input: CvJdMatchRequestDto): Promise<CvJdMatchResponseDto> {
    const template = this.prompts.get(input.scoring_template_code);
    const userPrompt = this.prompts.render(input.scoring_template_code, {
      cv_text: input.cv_text,
      jd_text: input.jd_text,
    });

    const aiRequestId = await this.tracing.startAiRequest({
      userId,
      modelCode: '',
      promptTemplateCode: template.code,
      promptTemplateVersion: template.version,
      requestType: 'cv_jd_match',
      requestPayload: { cv_id: input.cv_id, jd_id: input.jd_id },
    });

    const llmResult = await this.llm.complete(
      [
        { role: 'system', content: template.meta.system ?? '' },
        { role: 'user', content: userPrompt },
      ],
      { jsonMode: true, temperature: 0.2, maxOutputTokens: 2500 },
    );

    await this.tracing.completeAiRequest(aiRequestId, {
      promptTokens: llmResult.tokenUsage.promptTokens,
      completionTokens: llmResult.tokenUsage.completionTokens,
      totalTokens: llmResult.tokenUsage.totalTokens,
      latencyMs: llmResult.latencyMs,
      status: 'SUCCESS',
    });

    const parsed = (llmResult.parsedJson ?? {}) as CvJdMatchParsedResponse;

    await this.tracing.saveAiResult({
      aiRequestId,
      userId,
      resultType: 'cv_jd_match',
      rawResponse: llmResult.rawResponse,
      parsedResponse: parsed,
      totalScore: parsed.overall_score ?? 0,
      tokenUsage: llmResult.tokenUsage.totalTokens,
    });

    return {
      ai_request_id: aiRequestId,
      result_type: 'cv_jd_match',
      parsed_response: parsed,
      retrieval_log_id: null,
      retrieved_chunks_count: 0,
      token_usage: llmResult.tokenUsage.totalTokens,
      latency_ms: llmResult.latencyMs,
    };
  }
}

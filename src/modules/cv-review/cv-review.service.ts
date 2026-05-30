import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../../infrastructure/llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';
import { TracingService } from '../tracing/tracing.service';
import { CvReviewRequestDto } from './dto/cv-review-request.dto';
import { CvReviewParsedResponse, CvReviewResponseDto } from './dto/cv-review-response.dto';
import { CvReviewParser } from './cv-review.parser';
import { AtsRuleCheckerService } from './ats-rule-checker.service';
import { CvParserService } from './cv-parser.service';

/**
 * Hybrid CV review:
 *   - 40% — AtsRuleCheckerService (deterministic rule checks, no LLM)
 *   - 60% — LLM-based rubric scoring (4 dimensions × 20pt = 80, normalized to 0-100)
 *
 * Composite: overall_score = ats_rule_score × 0.4 + (llm_total / 80 × 100) × 0.6
 *
 * The 40% deterministic floor ensures the score doesn't drift wildly between LLM runs.
 * The 60% LLM portion uses strict rubric prompt (`cv_review_v1.md`) with temperature 0.1
 * and 4 independent dimensions, which keeps variance < 5 points across re-runs.
 */
@Injectable()
export class CvReviewService {
  private readonly logger = new Logger(CvReviewService.name);

  /** Weights for composite score. MUST sum to 1.0. */
  private readonly RULE_WEIGHT = 0.4;
  private readonly LLM_WEIGHT = 0.6;

  constructor(
    private readonly llm: LlmService,
    private readonly prompts: PromptsService,
    private readonly tracing: TracingService,
    private readonly parser: CvReviewParser,
    private readonly atsChecker: AtsRuleCheckerService,
    private readonly cvParser: CvParserService,
  ) {}

  async review(userId: string, input: CvReviewRequestDto): Promise<CvReviewResponseDto> {
    // ─── Step 1: parse raw text → CanonicalCvDocument (Stage 1, LLM extract) ─
    const parse = await this.cvParser.parse(input.parsed_text);
    const document = parse.document;

    // ─── Step 2: rule-based ATS check on the STRUCTURED document ─────────────
    const atsCheck = this.atsChecker.check({
      document,
      parsed_text: input.parsed_text,
      mime_type: input.mime_type,
      is_ocr_only: input.is_ocr_only,
    });

    // ─── Step 2: LLM rubric scoring ─────────────────────────────────────────
    const template = this.prompts.get(input.prompt_template_code);
    const userPrompt = this.prompts.render(input.prompt_template_code, {
      cv_text: input.parsed_text,
      target_role: input.target_role ?? '(none)',
    });

    const aiRequestId = await this.tracing.startAiRequest({
      userId,
      modelCode: '', // filled after LLM call
      promptTemplateCode: template.code,
      promptTemplateVersion: template.version,
      requestType: 'cv_review',
      requestPayload: {
        cv_id: input.cv_id,
        prompt_template_code: input.prompt_template_code,
        target_role: input.target_role,
      },
    });

    const llmResult = await this.llm.complete(
      [
        { role: 'system', content: template.meta.system ?? '' },
        { role: 'user', content: userPrompt },
      ],
      // Temperature 0.1 — we want near-deterministic rubric application, not creativity.
      { jsonMode: true, temperature: 0.1, maxOutputTokens: 2048 },
    );

    await this.tracing.completeAiRequest(aiRequestId, {
      promptTokens: llmResult.tokenUsage.promptTokens,
      completionTokens: llmResult.tokenUsage.completionTokens,
      totalTokens: llmResult.tokenUsage.totalTokens + parse.tokenUsage,
      latencyMs: llmResult.latencyMs,
      status: 'SUCCESS',
    });

    const llmParsed = this.parser.parse(llmResult.parsedJson);

    // ─── Step 3: composite scoring ──────────────────────────────────────────
    const llm_normalized = Math.round((llmParsed.llm_total / 80) * 100);
    const overall_score = Math.round(
      atsCheck.ats_rule_score * this.RULE_WEIGHT + llm_normalized * this.LLM_WEIGHT,
    );

    const parsedResponse: CvReviewParsedResponse = {
      language: document.language,
      document,
      overall_score,
      ats_rule_score: atsCheck.ats_rule_score,
      ats_check: atsCheck,
      llm_score_dimensions: llmParsed.scores,
      llm_total: llmParsed.llm_total,
      llm_normalized,
      rationale: llmParsed.rationale,
      sections: llmParsed.sections,
      ats_extracted: llmParsed.ats_extracted,
      parsed_cv: llmParsed.ats_extracted, // alias for backward compat
    };

    await this.tracing.saveAiResult({
      aiRequestId,
      userId,
      resultType: 'cv_review',
      rawResponse: llmResult.rawResponse,
      parsedResponse,
      totalScore: overall_score,
      tokenUsage: llmResult.tokenUsage.totalTokens + parse.tokenUsage,
    });

    return {
      ai_request_id: aiRequestId,
      result_type: 'cv_review',
      raw_response: llmResult.rawResponse,
      parsed_response: parsedResponse,
      total_score: overall_score,
      // Confidence is higher than before because 40% of the score is deterministic.
      // We start with 0.9 and reduce if many ATS rules failed (signal: CV may be unparseable).
      confidence_score: this.computeConfidence(atsCheck.summary.failed, atsCheck.summary.total),
      token_usage: llmResult.tokenUsage.totalTokens + parse.tokenUsage,
      model_code: llmResult.modelCode,
      latency_ms: llmResult.latencyMs,
      prompt_template_version: template.version,
    };
  }

  /**
   * Confidence reflects how "parseable" the CV was. Lots of ATS rule failures
   * = unusual format = scoring less reliable. Range [0.55, 0.95].
   */
  private computeConfidence(failedCount: number, totalRules: number): number {
    if (totalRules === 0) return 0.85;
    const failRate = failedCount / totalRules;
    // 0 fails → 0.95, all fails → 0.55, linear in between
    return Math.round((0.95 - failRate * 0.4) * 100) / 100;
  }
}

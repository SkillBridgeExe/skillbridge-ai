import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../../infrastructure/llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';
import { TracingService } from '../tracing/tracing.service';
import { CvJdMatchRequestDto } from './dto/cv-jd-match-request.dto';
import { CvJdMatchParsedResponse, CvJdMatchResponseDto } from './dto/cv-jd-match-response.dto';
import { RawCvSkill, RawJdRequirement, SkillDiffService } from './skill-diff.service';

interface LlmExtractionOutput {
  cv_skills_raw: RawCvSkill[];
  jd_requirements_raw: RawJdRequirement[];
}

/**
 * Refactored CV-JD match flow:
 *
 *   1. LLM only EXTRACTS skills + JD requirements as raw text + evidence + level hints.
 *      No LLM scoring, no LLM-decided weights.
 *
 *   2. SkillDiffService runs deterministic diff:
 *      - Normalize raw skills against taxonomy.
 *      - Source of "required skills" = role rubric (if target_role given) OR
 *        normalized JD requirements (fallback).
 *      - Compute matched / partial / missing arrays.
 *      - Compute weighted overall_score.
 *
 * Result: same input → same output. Cross-run variance approaches zero (only LLM
 * extraction varies, and even that's mitigated by temperature 0.1).
 */
@Injectable()
export class CvJdMatchService {
  private readonly logger = new Logger(CvJdMatchService.name);

  constructor(
    private readonly llm: LlmService,
    private readonly prompts: PromptsService,
    private readonly tracing: TracingService,
    private readonly skillDiff: SkillDiffService,
  ) {}

  async match(userId: string, input: CvJdMatchRequestDto): Promise<CvJdMatchResponseDto> {
    const template = this.prompts.get(input.scoring_template_code);
    const userPrompt = this.prompts.render(input.scoring_template_code, {
      cv_text: input.cv_text,
      jd_text: input.jd_text ?? '(no JD provided)',
    });

    const aiRequestId = await this.tracing.startAiRequest({
      userId,
      modelCode: '',
      promptTemplateCode: template.code,
      promptTemplateVersion: template.version,
      requestType: 'cv_jd_match',
      requestPayload: {
        cv_id: input.cv_id,
        jd_id: input.jd_id ?? null,
        target_role: input.target_role ?? null,
      },
    });

    const startedAt = Date.now();
    try {
      const llmResult = await this.llm.complete(
        [
          { role: 'system', content: template.meta.system ?? '' },
          { role: 'user', content: userPrompt },
        ],
        // Lower temperature — consistent extraction, not creative scoring (scoring is deterministic).
        { jsonMode: true, temperature: 0.1, maxOutputTokens: 2500 },
      );

      const extraction = this.parseLlmExtraction(llmResult.parsedJson);

      // Run deterministic diff — this is where scoring actually happens.
      const diff = this.skillDiff.diff({
        cv_skills_raw: extraction.cv_skills_raw,
        jd_requirements_raw: extraction.jd_requirements_raw,
        target_role: input.target_role,
      });

      // Determine source for telemetry / UI
      let sourceOfRequirements: 'role_rubric' | 'jd_extraction' | 'none' = 'none';
      if (input.target_role && diff.scoring_breakdown.total_requirements > 0) {
        sourceOfRequirements = 'role_rubric';
      } else if (extraction.jd_requirements_raw.length > 0) {
        sourceOfRequirements = 'jd_extraction';
      }

      const parsed: CvJdMatchParsedResponse = {
        overall_score: diff.overall_score,
        match_ratio: diff.match_ratio,
        required_coverage: diff.required_coverage,
        matched_skills: diff.matched_skills,
        partial_skills: diff.partial_skills,
        missing_skills: diff.missing_skills,
        bonus_skills: diff.bonus_skills,
        unnormalized_cv_skills: diff.unnormalized_cv_skills,
        unnormalized_jd_requirements: diff.unnormalized_jd_requirements,
        scoring_breakdown: diff.scoring_breakdown,
        source_of_requirements: sourceOfRequirements,
        target_role: input.target_role ?? null,
      };

      // Persist the result BEFORE marking SUCCESS (audit invariant: SUCCESS ⇒ has result).
      const aiResultId = await this.tracing.saveAiResult({
        aiRequestId,
        userId,
        resultType: 'cv_jd_match',
        rawResponse: llmResult.rawResponse,
        parsedResponse: parsed,
        totalScore: diff.overall_score,
        tokenUsage: llmResult.tokenUsage.totalTokens,
      });

      await this.tracing.completeAiRequest(aiRequestId, {
        promptTokens: llmResult.tokenUsage.promptTokens,
        completionTokens: llmResult.tokenUsage.completionTokens,
        totalTokens: llmResult.tokenUsage.totalTokens,
        estimatedCost: llmResult.estimatedCostUsd,
        latencyMs: llmResult.latencyMs,
        status: 'SUCCESS',
      });

      if (diff.unnormalized_cv_skills.length + diff.unnormalized_jd_requirements.length > 0) {
        this.logger.warn(
          `Match request ${aiRequestId}: ${diff.unnormalized_cv_skills.length} CV skills + ` +
            `${diff.unnormalized_jd_requirements.length} JD requirements did not normalize — ` +
            `consider expanding taxonomy.`,
        );
      }

      return {
        ai_request_id: aiRequestId,
        ai_result_id: aiResultId,
        result_type: 'cv_jd_match',
        parsed_response: parsed,
        retrieval_log_id: null,
        retrieved_chunks_count: 0,
        token_usage: llmResult.tokenUsage.totalTokens,
        latency_ms: llmResult.latencyMs,
      };
    } catch (err) {
      // LLM/parse/persist failed after the PENDING row was created — mark it FAILED so the
      // trace never accumulates orphan PENDING rows (mirrors cv-review).
      await this.tracing.markFailed(aiRequestId, startedAt, err);
      throw err;
    }
  }

  private parseLlmExtraction(raw: unknown): LlmExtractionOutput {
    if (!raw || typeof raw !== 'object') {
      return { cv_skills_raw: [], jd_requirements_raw: [] };
    }
    const obj = raw as Record<string, unknown>;
    const cv = Array.isArray(obj.cv_skills_raw) ? (obj.cv_skills_raw as RawCvSkill[]) : [];
    const jd = Array.isArray(obj.jd_requirements_raw)
      ? (obj.jd_requirements_raw as RawJdRequirement[])
      : [];
    return { cv_skills_raw: cv, jd_requirements_raw: jd };
  }
}

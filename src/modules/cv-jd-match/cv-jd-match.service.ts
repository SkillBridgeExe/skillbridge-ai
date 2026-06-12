import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../../infrastructure/llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';
import { TracingService } from '../tracing/tracing.service';
import { CvJdMatchRequestDto } from './dto/cv-jd-match-request.dto';
import {
  CvJdMatchParsedResponse,
  CvJdMatchResponseDto,
  KeywordFrequency,
} from './dto/cv-jd-match-response.dto';
import {
  ScannedSkill,
  SkillTextScannerService,
} from '../../common/services/skill-text-scanner.service';
import { RawCvSkill, RawJdRequirement, SkillDiffService } from './skill-diff.service';
import { assessTextQuality } from '../../common/services/text-quality';
import { maskPii, maskPiiDeep } from '../../common/services/pii-mask';

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
 *      - Source of "required skills" = a provided JD (PRECEDENCE); the role rubric is
 *        the fallback when target_role has one and there's no usable JD.
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
    private readonly scanner: SkillTextScannerService,
  ) {}

  async match(userId: string, input: CvJdMatchRequestDto): Promise<CvJdMatchResponseDto> {
    // Content gate: a pasted "JD" that is junk ("aa", "test test") must never reach the
    // extraction LLM — burning cost and silently degrading to the rubric would confuse the
    // user ("why is my score against generic requirements?"). Absent/empty JD stays legal
    // (rubric fallback is the designed path); only PROVIDED-but-garbage JDs are rejected.
    const jdText = input.jd_text?.trim();
    if (jdText) {
      const quality = assessTextQuality(jdText, {
        minMeaningfulTokens: 6,
        minMeaningfulChars: 40,
      });
      if (!quality.ok) {
        throw new BadRequestException({
          code: 'JD_CONTENT_INSUFFICIENT',
          message:
            'Nội dung JD quá ngắn hoặc không phải mô tả công việc — hãy dán JD thật (yêu cầu, kỹ năng, mô tả). / ' +
            'The pasted JD is too thin or not a job description — paste the real JD (requirements, skills, description).',
        });
      }
    }

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

      // OFF-TOPIC guard (deterministic, post-extraction): the user PROVIDED a JD that passed
      // the thin-content gate, yet extraction found zero job requirements in it while the CV
      // side extracted fine — e.g. a recipe, a news article, chat. Silently falling back to
      // the role rubric would score the CV against requirements the user never pasted and
      // read as "26% match" for nonsense input. Reject deterministically instead. The LLM
      // call already happened, so the trace completes as SUCCESS first (cost stays visible) —
      // mirrors the cv-rewrite OFF_TOPIC precedent. Reuses JD_CONTENT_INSUFFICIENT so the FE
      // gate mapping ("paste a real JD") applies unchanged.
      if (
        jdText &&
        extraction.jd_requirements_raw.length === 0 &&
        extraction.cv_skills_raw.length > 0
      ) {
        await this.tracing.completeAiRequest(aiRequestId, {
          promptTokens: llmResult.tokenUsage.promptTokens,
          completionTokens: llmResult.tokenUsage.completionTokens,
          totalTokens: llmResult.tokenUsage.totalTokens,
          estimatedCost: llmResult.estimatedCostUsd,
          latencyMs: llmResult.latencyMs,
          status: 'SUCCESS',
        });
        throw new BadRequestException({
          code: 'JD_CONTENT_INSUFFICIENT',
          message:
            'Không nhận diện được yêu cầu công việc nào trong nội dung đã dán — có vẻ đây không phải JD. Hãy dán mô tả công việc thật (yêu cầu, kỹ năng, trách nhiệm). / ' +
            'No job requirements could be recognized in the pasted text — it does not look like a job description. Paste a real JD (requirements, skills, responsibilities).',
        });
      }

      // Run deterministic diff — this is where scoring actually happens.
      // PRODUCT default band = 'fresher' (our audience); the pure diff layer defaults to
      // 'mid' so eval pairs/tests stay byte-identical. JD path ignores the band entirely.
      const diff = this.skillDiff.diff({
        cv_skills_raw: extraction.cv_skills_raw,
        jd_requirements_raw: extraction.jd_requirements_raw,
        target_role: input.target_role,
        target_band: input.target_band ?? 'fresher',
      });

      // Source is decided inside the diff (JD wins over rubric) — read it, don't re-derive.
      const sourceOfRequirements = diff.requirements_source;

      const cvScan = this.scanner.scan(input.cv_text);
      const jdScan = this.scanner.scan(input.jd_text ?? '');
      const keyword_frequency = buildKeywordFrequency(
        [...diff.matched_skills, ...diff.partial_skills, ...diff.missing_skills],
        cvScan,
        jdScan,
      );

      const parsed: CvJdMatchParsedResponse = {
        overall_score: diff.overall_score,
        match_ratio: diff.match_ratio,
        required_coverage: diff.required_coverage,
        matched_skills: diff.matched_skills,
        partial_skills: diff.partial_skills,
        missing_skills: diff.missing_skills,
        bonus_skills: diff.bonus_skills,
        keyword_frequency,
        unnormalized_cv_skills: diff.unnormalized_cv_skills,
        unnormalized_jd_requirements: diff.unnormalized_jd_requirements,
        scoring_breakdown: diff.scoring_breakdown,
        inferred_skills: diff.inferred_skills,
        source_of_requirements: sourceOfRequirements,
        target_role: input.target_role ?? null,
        rubric_band: diff.rubric_band,
      };

      // Persist the result BEFORE marking SUCCESS (audit invariant: SUCCESS ⇒ has result).
      // PRIVACY: the persisted copy is PII-masked (per-skill evidence_text quotes CV lines that
      // carry email/phone) — parity with cv-review's redacted trace. The caller still gets the
      // unmasked `parsed` below; the masked copy is what the gap report later reads back.
      const aiResultId = await this.tracing.saveAiResult({
        aiRequestId,
        userId,
        resultType: 'cv_jd_match',
        rawResponse: maskPii(
          typeof llmResult.rawResponse === 'string'
            ? llmResult.rawResponse
            : JSON.stringify(llmResult.rawResponse),
        ),
        parsedResponse: maskPiiDeep(parsed),
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
      // The OFF-TOPIC rejection above is a SUCCESSFUL call whose trace is already completed —
      // re-throw without flipping it to FAILED (mirrors cv-rewrite).
      if (err instanceof BadRequestException) throw err;
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

/** Pure: occurrence counts (CV vs JD) for the requirement∪matched skill set. Deduped by canonical. */
export function buildKeywordFrequency(
  reqSkills: Array<{ canonical_name: string; display_name: string }>,
  cvScan: ScannedSkill[],
  jdScan: ScannedSkill[],
): KeywordFrequency[] {
  const cv = new Map(cvScan.map((s) => [s.canonical_name, s.occurrences]));
  const jd = new Map(jdScan.map((s) => [s.canonical_name, s.occurrences]));
  const seen = new Set<string>();
  const out: KeywordFrequency[] = [];
  for (const s of reqSkills) {
    if (seen.has(s.canonical_name)) continue;
    seen.add(s.canonical_name);
    out.push({
      canonical_name: s.canonical_name,
      display_name: s.display_name,
      cv_count: cv.get(s.canonical_name) ?? 0,
      jd_count: jd.get(s.canonical_name) ?? 0,
    });
  }
  return out;
}

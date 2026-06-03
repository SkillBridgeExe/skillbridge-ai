import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../../infrastructure/llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';
import { TracingService } from '../tracing/tracing.service';
import { CvReviewRequestDto } from './dto/cv-review-request.dto';
import {
  CvReviewParsedResponse,
  CvReviewResponseDto,
  CvReviewSectionIssue,
} from './dto/cv-review-response.dto';
import { CvReviewLlmRawOutput, CvReviewParser } from './cv-review.parser';
import { AtsRuleCheckerService } from './ats-rule-checker.service';
import { CvParserService } from './cv-parser.service';
import { RoleRubricService } from '../../common/services/role-rubric.service';
import { BulletAnalysis, BulletAnalyzerService } from './bullet-analyzer.service';
import scoringWeights from './scoring-weights-v1.json';

/**
 * Hybrid CV review:
 *   - 40% — AtsRuleCheckerService (deterministic rule checks, no LLM)
 *   - 60% — rubric scoring (4 dimensions × 20pt = 80, normalized to 0-100)
 *
 * Composite: overall_score = ats_rule_score × 0.4 + (llm_total / 80 × 100) × 0.6
 * (weights are externalized + versioned in `scoring-weights-v1.json`).
 *
 * Routed-Evidence Scoring (docs/cv-scoring-architecture.md): each dimension is scored by the
 * BEST scorer for it. Dimension 1 (Action Verbs & Quantified Impact) is a MECHANICAL fact —
 * counting verb-first / quantified / passive bullets — so it is scored DETERMINISTICALLY by
 * BulletAnalyzerService and OVERRIDES the LLM's estimate. This makes Dim-1 fully reproducible
 * (stddev = 0), injection-resistant (a CV cannot talk the analyzer into a high score), and
 * explainable (raw signals are surfaced). The holistic dimensions (Experience, Education) stay
 * with the LLM (temperature 0.1) which keeps their variance < 5 points across re-runs.
 */
@Injectable()
export class CvReviewService {
  private readonly logger = new Logger(CvReviewService.name);

  /** Composite weights — externalized + versioned. Validated to sum to 1.0 at construction. */
  private readonly RULE_WEIGHT = scoringWeights.rule_weight;
  private readonly LLM_WEIGHT = scoringWeights.llm_weight;

  constructor(
    private readonly llm: LlmService,
    private readonly prompts: PromptsService,
    private readonly tracing: TracingService,
    private readonly parser: CvReviewParser,
    private readonly atsChecker: AtsRuleCheckerService,
    private readonly cvParser: CvParserService,
    private readonly roleRubric: RoleRubricService,
    private readonly bulletAnalyzer: BulletAnalyzerService,
  ) {
    const sum = this.RULE_WEIGHT + this.LLM_WEIGHT;
    if (Math.abs(sum - 1) > 1e-9) {
      throw new Error(
        `Invalid ${scoringWeights.version}: rule_weight + llm_weight must sum to 1.0 (got ${sum}).`,
      );
    }
  }

  async review(userId: string, input: CvReviewRequestDto): Promise<CvReviewResponseDto> {
    const startedAt = Date.now();

    // ─── Step 1: parse raw text → CanonicalCvDocument (Stage 1, LLM extract) ─
    // Stage 1 + the deterministic ATS check run BEFORE the ai_request row is created, so a
    // failure here surfaces directly with no PENDING row left orphaned.
    const parse = await this.cvParser.parse(input.parsed_text);
    const document = parse.document;

    // ─── Step 2: rule-based ATS check on the STRUCTURED document ─────────────
    const atsCheck = this.atsChecker.check({
      document,
      parsed_text: input.parsed_text,
      mime_type: input.mime_type,
      is_ocr_only: input.is_ocr_only,
    });

    // ─── Step 3: LLM rubric scoring ─────────────────────────────────────────
    const template = this.prompts.get(input.prompt_template_code);
    // #7: feed the authoritative role rubric (seeded skills + required level + weight) so
    // skills_relevance is scored against ground truth, not the model's own idea of the role.
    const rubricText = this.buildRubricText(input.target_role);
    const userPrompt = this.prompts.render(input.prompt_template_code, {
      // Gap fix (deterministic-first): feed the STRUCTURED document as the primary CV
      // representation so the rubric scores from pre-extracted fields (lower variance),
      // plus the detected language so feedback matches the CV's language.
      // Raw text is kept only as a secondary reference.
      cv: JSON.stringify(document, null, 2),
      cv_text: input.parsed_text,
      target_role: input.target_role ?? '(none)',
      language: document.language,
      rubric: rubricText,
    });

    const aiRequestId = await this.tracing.startAiRequest({
      userId,
      modelCode: '', // resolved + backfilled on completion (model is known only after the call)
      promptTemplateCode: template.code,
      promptTemplateVersion: template.version,
      requestType: 'cv_review',
      requestPayload: {
        cv_id: input.cv_id,
        prompt_template_code: input.prompt_template_code,
        target_role: input.target_role,
      },
    });

    try {
      const llmResult = await this.llm.complete(
        [
          { role: 'system', content: template.meta.system ?? '' },
          { role: 'user', content: userPrompt },
        ],
        // Temperature 0.1 — near-deterministic rubric application, not creativity.
        // maxOutputTokens has headroom for a fully-populated rubric (esp. Vietnamese output).
        { jsonMode: true, temperature: 0.1, maxOutputTokens: 4096 },
      );

      // Validate/parse the LLM output BEFORE marking the request SUCCESS — a malformed
      // response must FAIL the request, not leave a SUCCESS row with no result.
      const llmParsed = this.parser.parse(llmResult.parsedJson);

      // ─── Routed-Evidence: Dimension-1 is scored deterministically ───────────
      // Replace the LLM's action_verbs estimate (+ its rationale & section feedback) with the
      // analyzer's reproducible, injection-resistant result computed from the STRUCTURED document.
      const bulletAnalysis = this.bulletAnalyzer.analyze(document);
      const routed = this.routeDimension1(llmParsed, bulletAnalysis);

      // ─── Step 4: composite scoring (round ONCE on the unrounded value) ──────
      const llm_normalized = Math.round((routed.llm_total / 80) * 100);
      const overall_score = Math.round(
        atsCheck.ats_rule_score * this.RULE_WEIGHT +
          (routed.llm_total / 80) * 100 * this.LLM_WEIGHT,
      );
      const confidence_score = this.computeConfidence(
        atsCheck.summary.failed,
        atsCheck.summary.total,
      );
      // The ai_request row records its OWN call's tokens (self-consistent: prompt+completion=total).
      // Stage-1 parse tokens are aggregated only into the result-level total below.
      const combinedTokens = llmResult.tokenUsage.totalTokens + parse.tokenUsage;

      const parsedResponse: CvReviewParsedResponse = {
        language: document.language,
        document,
        overall_score,
        ats_rule_score: atsCheck.ats_rule_score,
        ats_check: atsCheck,
        llm_score_dimensions: routed.scores,
        llm_total: routed.llm_total,
        llm_normalized,
        rationale: routed.rationale,
        sections: routed.sections,
        ats_extracted: routed.ats_extracted,
        parsed_cv: routed.ats_extracted, // alias for backward compat
        // Explainability + calibration: the raw deterministic Dim-1 signals (trustworthy,
        // non-LLM labels). scoring_weights_version pins which weight set produced overall_score.
        action_verbs_analysis: bulletAnalysis,
        scoring_weights_version: scoringWeights.version,
      };

      await this.tracing.completeAiRequest(aiRequestId, {
        promptTokens: llmResult.tokenUsage.promptTokens,
        completionTokens: llmResult.tokenUsage.completionTokens,
        totalTokens: llmResult.tokenUsage.totalTokens,
        latencyMs: llmResult.latencyMs,
        status: 'SUCCESS',
        modelCode: llmResult.modelCode,
      });

      await this.tracing.saveAiResult({
        aiRequestId,
        userId,
        resultType: 'cv_review',
        // #9/#13: persist a PII-redacted copy (mask emails + drop contact identity). The full
        // data is still returned to the (authenticated) caller below — only the trace is redacted.
        rawResponse: this.maskEmails(llmResult.text ?? JSON.stringify(llmResult.rawResponse)),
        parsedResponse: this.redactForTrace(parsedResponse),
        totalScore: overall_score,
        confidenceScore: confidence_score,
        tokenUsage: combinedTokens,
      });

      return {
        ai_request_id: aiRequestId,
        result_type: 'cv_review',
        raw_response: llmResult.rawResponse,
        parsed_response: parsedResponse,
        total_score: overall_score,
        // Confidence is higher when more of the score is deterministic; it drops as ATS
        // rule failures rise (signal: CV may be unparseable). Range [0.55, 0.95].
        confidence_score,
        token_usage: combinedTokens,
        model_code: llmResult.modelCode,
        latency_ms: llmResult.latencyMs,
        prompt_template_version: template.version,
      };
    } catch (err) {
      // LLM call / parse / persistence failed after the PENDING row was created — mark it
      // FAILED (with latency + reason) so the trace never accumulates orphan PENDING rows.
      await this.tracing
        .completeAiRequest(aiRequestId, {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          latencyMs: Date.now() - startedAt,
          status: 'FAILED',
          errorMessage: err instanceof Error ? err.message : String(err),
        })
        .catch(() => undefined);
      throw err;
    }
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

  /**
   * Routed-Evidence: overlay the deterministic Dimension-1 result onto the LLM output —
   * replace its action_verbs score, recompute llm_total, and regenerate Dim-1 rationale +
   * section feedback from the analyzer's signals so the UI never shows a contradictory
   * LLM number. All other dimensions are left untouched.
   */
  private routeDimension1(
    llmParsed: CvReviewLlmRawOutput,
    analysis: BulletAnalysis,
  ): CvReviewLlmRawOutput {
    const scores = { ...llmParsed.scores, action_verbs: analysis.actionVerbsScore };
    const llm_total =
      scores.action_verbs + scores.skills_relevance + scores.experience + scores.education;
    const rationale = { ...llmParsed.rationale, action_verbs: this.dim1Rationale(analysis) };

    // Make the Dim-1 section authoritative: rewrite the FIRST matching section (so a broad
    // label match can't duplicate it onto a sibling), and if NONE matches — e.g. the LLM
    // localized the label to Vietnamese — prepend a fresh one, so a stale LLM action-verbs
    // section can never contradict the deterministic score.
    const dim1Section = {
      name: 'Action Verbs & Impact',
      score: Math.round((analysis.actionVerbsScore / 20) * 100),
      issues: this.dim1Issues(analysis),
    };
    let replaced = false;
    const sections = llmParsed.sections.map((s) => {
      if (!replaced && this.isDim1Section(s.name)) {
        replaced = true;
        return { ...dim1Section, name: s.name };
      }
      return s;
    });
    if (!replaced) sections.unshift(dim1Section);

    return { ...llmParsed, scores, llm_total, rationale, sections };
  }

  /** Match the Action-Verbs section regardless of the exact label the prompt used. */
  private isDim1Section(name: string): boolean {
    return /action|verb|impact/i.test(name);
  }

  /** Evidence-based, deterministic one-liner for the Dim-1 rationale. */
  private dim1Rationale(a: BulletAnalysis): string {
    if (a.bulletCount === 0) {
      return 'No experience/project/activity bullets were found to evaluate (deterministic analysis).';
    }
    return (
      `${Math.round(a.verbFirstRatio * 100)}% of ${a.bulletCount} bullets open with a strong action verb ` +
      `and ${Math.round(a.quantifiedRatio * 100)}% are quantified (deterministic analysis).`
    );
  }

  /** Turn the analyzer's notes into actionable section issues (or a single info note if clean). */
  private dim1Issues(a: BulletAnalysis): CvReviewSectionIssue[] {
    if (a.notes.length === 0) {
      return [
        {
          severity: 'info',
          text: 'Bullets are action-oriented and quantified.',
        },
      ];
    }
    const severity: CvReviewSectionIssue['severity'] =
      a.actionVerbsScore >= 13 ? 'info' : 'warning';
    return a.notes.map((text) => ({ severity, text }));
  }

  /** #7: render the authoritative required-skill list for the target role (if seeded). */
  private buildRubricText(targetRole?: string): string {
    const rubric = targetRole ? this.roleRubric.getRubric(targetRole) : null;
    if (!rubric) {
      return `(No seeded rubric for "${targetRole ?? '(none)'}". Score skills_relevance against generic tech-industry expectations for this role.)`;
    }
    const lines = rubric.skills
      .map(
        (s) =>
          `- ${s.skill_canonical_name} — needs level ${s.required_level}/5 · ${s.importance} · weight ${s.weight.toFixed(2)}`,
      )
      .join('\n');
    return (
      `Authoritative required skills for "${rubric.display_name_en}" (the ground truth for this role). ` +
      `Score skills_relevance by how well the CV covers this list: REQUIRED gaps hurt most, then PREFERRED, then NICE_TO_HAVE; ` +
      `higher weight = more important; a skill below its required level counts only partially.\n${lines}`
    );
  }

  /** Mask email addresses in an arbitrary string (PII redaction for trace persistence). */
  private maskEmails(text: string): string {
    return text.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[redacted-email]');
  }

  /**
   * #9/#13: redact PII before persisting to ai_results — mask emails everywhere and drop
   * contact identity fields. Date ranges / scores are untouched (no broad number masking).
   */
  private redactForTrace(parsed: CvReviewParsedResponse): CvReviewParsedResponse {
    const clone = JSON.parse(this.maskEmails(JSON.stringify(parsed))) as CvReviewParsedResponse;
    if (clone.document?.contact) {
      clone.document.contact.name = null;
      clone.document.contact.email = null;
      clone.document.contact.phone = null;
      clone.document.contact.location = null;
    }
    for (const extracted of [clone.ats_extracted, clone.parsed_cv]) {
      if (extracted) {
        extracted.name = null;
        extracted.email = null;
        extracted.phone = null;
      }
    }
    return clone;
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../../infrastructure/database/database.service';
import { LlmService } from '../../../infrastructure/llm/llm.service';
import { PromptsService } from '../../prompts/prompts.service';
import { TracingService } from '../../tracing/tracing.service';
import { SkillDemandService } from './skill-demand.service';
import { buildFacts, groundInsight } from './trends-insight.logic';
import { TrendsInsightRequest, TrendsInsightResponse } from './trends-insight.types';

const PROMPT_CODE = 'trends_insight_v1';

/**
 * "AI nhận định" over trends. Deterministic-first: numbers come from SkillDemandService;
 * the LLM only writes prose, and groundInsight discards anything not in FACTS.
 * Cached per (cv_key, role, period) — the nightly snapshot period invalidates it.
 */
@Injectable()
export class TrendsInsightService {
  private readonly logger = new Logger(TrendsInsightService.name);

  constructor(
    private readonly demand: SkillDemandService,
    private readonly llm: LlmService,
    private readonly prompts: PromptsService,
    private readonly tracing: TracingService,
    private readonly db: DatabaseService,
  ) {}

  async generate(req: TrendsInsightRequest): Promise<TrendsInsightResponse> {
    const role = req.role_code ?? 'all';
    const limit = req.limit ?? 12;
    const cvKey = req.cv_id ?? 'none';

    // getTrends first → throws NO_SNAPSHOT (404) if trends not materialized; gives the period (cache key).
    const trends = await this.demand.getTrends(role, limit);

    const cached = await this.readCache(cvKey, role, trends.period);
    if (cached) return this.withStale({ ...cached, cached: true });

    // Personalized: resolve the CV's covered skill set (getSkillGap also enforces CV ownership → 404).
    let coveredCanonicals: Set<string> | null = null;
    if (req.cv_id) {
      const gap = await this.demand.getSkillGap(req.user_id, req.cv_id, role, limit);
      coveredCanonicals = new Set(gap.skills.filter((s) => s.covered).map((s) => s.canonical_name));
    }
    // Insight sâu v1: cặp kỹ năng đi cùng nhau (đếm SQL trên pool active) — nguồn duy nhất
    // cho skill_pairs; LLM chỉ được viết lời trên các cặp này (guard trong groundInsight).
    const coOccurrence = await this.demand.getCoOccurrence(role, 10);
    const facts = buildFacts(trends, coveredCanonicals, coOccurrence);

    const startedAt = Date.now();
    const template = this.prompts.get(PROMPT_CODE);
    const aiRequestId = await this.tracing.startAiRequest({
      userId: req.user_id,
      modelCode: '',
      promptTemplateCode: template.code,
      promptTemplateVersion: template.version,
      requestType: 'trends_insight',
      requestPayload: { role_code: role, cv_id: req.cv_id ?? null, period: trends.period },
    });

    try {
      const userPrompt = this.prompts.render(PROMPT_CODE, {
        facts: JSON.stringify(facts, null, 2),
      });
      const llmResult = await this.llm.complete(
        [
          { role: 'system', content: template.meta.system ?? '' },
          { role: 'user', content: userPrompt },
        ],
        {
          provider: 'openai',
          jsonMode: true,
          temperature: 0.3,
          maxOutputTokens: 700,
          // Pinned to a non-reasoning model: the global default (gpt-5.x family) makes
          // buildChatParams DROP temperature and force max_completion_tokens ≥ 8192, silently
          // voiding the temp-0.3/700-token design of this call. Env still overrides.
          model: process.env.TRENDS_INSIGHT_MODEL || 'gpt-4o-mini',
        },
      );

      const grounded = groundInsight(llmResult.parsedJson, facts);

      await this.tracing.saveAiResult({
        aiRequestId,
        userId: req.user_id,
        resultType: 'trends_insight',
        rawResponse: llmResult.text,
        parsedResponse: grounded,
        tokenUsage: llmResult.tokenUsage.totalTokens,
      });
      await this.tracing.completeAiRequest(aiRequestId, {
        promptTokens: llmResult.tokenUsage.promptTokens,
        completionTokens: llmResult.tokenUsage.completionTokens,
        totalTokens: llmResult.tokenUsage.totalTokens,
        estimatedCost: llmResult.estimatedCostUsd,
        latencyMs: llmResult.latencyMs,
        status: 'SUCCESS',
        modelCode: llmResult.modelCode,
      });

      await this.writeCache(cvKey, role, trends.period, grounded, llmResult.modelCode);
      return this.withStale(grounded);
    } catch (err) {
      await this.tracing.markFailed(aiRequestId, startedAt, err);
      this.logger.warn(`trends_insight degraded to fallback: ${(err as Error).message}`);
      return this.withStale(groundInsight(null, facts));
    }
  }

  /** Snapshot cadence is nightly (external cron); a period older than this = the cron is not
   *  running and the narrative must disclose it. Computed at response time — never cached. */
  private static readonly STALE_AFTER_DAYS = 3;

  private withStale(r: TrendsInsightResponse): TrendsInsightResponse {
    const periodMs = Date.parse(r.period);
    const stale = Number.isFinite(periodMs)
      ? Date.now() - periodMs > TrendsInsightService.STALE_AFTER_DAYS * 86_400_000
      : true; // unparseable period = cannot prove freshness → disclose
    return { ...r, stale };
  }

  private async readCache(
    cvKey: string,
    role: string,
    period: string,
  ): Promise<TrendsInsightResponse | null> {
    const rows = await this.db.query<{ payload: TrendsInsightResponse }>(
      `SELECT payload FROM public.trends_insights WHERE cv_key = $1 AND role_code = $2 AND period = $3`,
      [cvKey, role, period],
    );
    return rows[0]?.payload ?? null;
  }

  private async writeCache(
    cvKey: string,
    role: string,
    period: string,
    payload: TrendsInsightResponse,
    model: string,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO public.trends_insights (cv_key, role_code, period, payload, model)
         VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (cv_key, role_code, period)
         DO UPDATE SET payload = EXCLUDED.payload, model = EXCLUDED.model, created_at = now()`,
      [cvKey, role, period, JSON.stringify(payload), model],
    );
  }
}

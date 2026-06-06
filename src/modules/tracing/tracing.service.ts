import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { AiRequestEntity } from '../../database/entities/ai-request.entity';
import { AiResultEntity } from '../../database/entities/ai-result.entity';

export interface StartAiRequestInput {
  userId: string;
  aiJobId?: string;
  modelCode: string;
  promptTemplateCode?: string;
  promptTemplateVersion?: number;
  requestType: string;
  requestPayload: unknown;
}

export interface CompleteAiRequestInput {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCost?: number;
  latencyMs: number;
  status: 'SUCCESS' | 'FAILED';
  errorMessage?: string;
  /** Resolved model code, backfilled into request_payload.model_code on completion. */
  modelCode?: string;
}

export interface SaveAiResultInput {
  aiRequestId: string;
  userId?: string;
  resultType: string;
  rawResponse: unknown;
  parsedResponse: unknown;
  totalScore?: number;
  confidenceScore?: number;
  tokenUsage?: number;
}

export interface LogRetrievalInput {
  aiRequestId?: string;
  userId?: string;
  queryText: string;
  topK: number;
  retrievedChunks: unknown;
}

export interface LogToolCallInput {
  aiRequestId?: string;
  toolName: string;
  inputPayload: unknown;
  outputPayload?: unknown;
  latencyMs?: number;
  status: 'SUCCESS' | 'FAILED' | 'PENDING';
  errorMessage?: string;
}

/**
 * Writes to ai_requests / ai_results / retrieval_logs / ai_tool_calls.
 */
@Injectable()
export class TracingService {
  private readonly logger = new Logger(TracingService.name);

  constructor(
    @Optional()
    @InjectRepository(AiRequestEntity)
    private readonly aiRequests?: Repository<AiRequestEntity>,
    @Optional()
    @InjectRepository(AiResultEntity)
    private readonly aiResults?: Repository<AiResultEntity>,
  ) {}

  async startAiRequest(input: StartAiRequestInput): Promise<string> {
    if (!this.aiRequests) return this.stubAiRequest(input);

    const request = await this.aiRequests.save(
      this.aiRequests.create({
        userId: input.userId,
        aiJobId: input.aiJobId ?? null,
        modelId: null,
        promptTemplateId: null,
        requestType: input.requestType,
        requestPayload: {
          model_code: input.modelCode,
          prompt_template_code: input.promptTemplateCode ?? null,
          prompt_template_version: input.promptTemplateVersion ?? null,
          payload: input.requestPayload,
        },
        status: 'PENDING',
      }),
    );
    return request.id;
  }

  async completeAiRequest(aiRequestId: string, input: CompleteAiRequestInput): Promise<void> {
    if (!this.aiRequests) {
      this.logger.debug(
        `[stub] ai_requests UPDATE id=${aiRequestId} status=${input.status} model=${input.modelCode ?? '?'} tokens=${input.totalTokens} latency=${input.latencyMs}ms`,
      );
      return;
    }

    await this.aiRequests.update(aiRequestId, {
      promptTokens: input.promptTokens,
      completionTokens: input.completionTokens,
      totalTokens: input.totalTokens,
      estimatedCost: input.estimatedCost === undefined ? null : input.estimatedCost.toFixed(6),
      latencyMs: input.latencyMs,
      status: input.status,
      errorMessage: input.errorMessage ?? null,
    });

    // startAiRequest runs before the model is known (model_code stored as ''), so backfill
    // the resolved model into request_payload now.
    if (input.modelCode) {
      await this.aiRequests.manager.query(
        `UPDATE ai_requests SET request_payload = jsonb_set(coalesce(request_payload, '{}'::jsonb), '{model_code}', to_jsonb($1::text), true) WHERE id = $2`,
        [input.modelCode, aiRequestId],
      );
    }
  }

  /**
   * Mark a still-PENDING ai_request FAILED after an error in the call/parse/persist path.
   * Best-effort (swallows its own error) so it never masks the original failure. Use in the
   * catch block of every traced LLM flow so a thrown call can't leave an orphan PENDING row.
   */
  async markFailed(aiRequestId: string, startedAt: number, err: unknown): Promise<void> {
    await this.completeAiRequest(aiRequestId, {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      latencyMs: Date.now() - startedAt,
      status: 'FAILED',
      errorMessage: err instanceof Error ? err.message : String(err),
    }).catch(() => undefined);
  }

  /**
   * Count a user's AI requests of a given type since `since` (inclusive). Backs the per-user
   * daily usage quota — counting `ai_requests` rows means no separate usage table is needed
   * and every metered attempt (PENDING/SUCCESS/FAILED) is included, so a flood of failing
   * calls still consumes quota (each may have hit the paid model). Returns 0 in the stub/test
   * path (no repo) so quota never blocks where tracing is disabled.
   */
  async countRequestsSince(userId: string, requestType: string, since: Date): Promise<number> {
    if (!this.aiRequests) return 0;
    return this.aiRequests.count({
      where: { userId, requestType, createdAt: MoreThanOrEqual(since) },
    });
  }

  async saveAiResult(input: SaveAiResultInput): Promise<string> {
    if (!this.aiResults) {
      const id = uuidv4();
      this.logger.debug(`[stub] ai_results INSERT id=${id} type=${input.resultType}`);
      return id;
    }

    const result = await this.aiResults.save(
      this.aiResults.create({
        aiRequestId: input.aiRequestId,
        userId: input.userId ?? null,
        resultType: input.resultType,
        rawResponse: input.rawResponse,
        parsedResponse: input.parsedResponse,
        totalScore: input.totalScore === undefined ? null : input.totalScore.toFixed(2),
        confidenceScore:
          input.confidenceScore === undefined ? null : input.confidenceScore.toFixed(2),
        tokenUsage: input.tokenUsage ?? null,
      }),
    );
    return result.id;
  }

  async logRetrieval(input: LogRetrievalInput): Promise<string> {
    const id = uuidv4();
    this.logger.debug(`[stub] retrieval_logs INSERT id=${id} topK=${input.topK}`);
    return id;
  }

  async logToolCall(input: LogToolCallInput): Promise<string> {
    const id = uuidv4();
    this.logger.debug(
      `[stub] ai_tool_calls INSERT id=${id} tool=${input.toolName} status=${input.status}`,
    );
    return id;
  }

  private stubAiRequest(input: StartAiRequestInput): string {
    const id = uuidv4();
    this.logger.debug(`[stub] ai_requests INSERT id=${id} type=${input.requestType}`);
    return id;
  }
}

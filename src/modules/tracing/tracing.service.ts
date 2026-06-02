import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
        `[stub] ai_requests UPDATE id=${aiRequestId} status=${input.status} tokens=${input.totalTokens} latency=${input.latencyMs}ms`,
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

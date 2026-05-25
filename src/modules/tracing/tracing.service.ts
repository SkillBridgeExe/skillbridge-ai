import { Injectable, Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from '../../infrastructure/database/database.service';

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
 *
 * Stub: real implementation uses DatabaseService once .NET runs the migration.
 * For now, we log to console and return generated UUIDs so feature code can be wired.
 */
@Injectable()
export class TracingService {
  private readonly logger = new Logger(TracingService.name);

  constructor(private readonly db: DatabaseService) {}

  async startAiRequest(input: StartAiRequestInput): Promise<string> {
    const id = uuidv4();
    this.logger.debug(`[stub] ai_requests INSERT id=${id} type=${input.requestType}`);
    // TODO: INSERT INTO ai_requests (...) VALUES (...)
    return id;
  }

  async completeAiRequest(aiRequestId: string, input: CompleteAiRequestInput): Promise<void> {
    this.logger.debug(
      `[stub] ai_requests UPDATE id=${aiRequestId} status=${input.status} tokens=${input.totalTokens} latency=${input.latencyMs}ms`,
    );
    // TODO: UPDATE ai_requests SET ... WHERE id = $1
  }

  async saveAiResult(input: SaveAiResultInput): Promise<string> {
    const id = uuidv4();
    this.logger.debug(`[stub] ai_results INSERT id=${id} type=${input.resultType}`);
    // TODO: INSERT INTO ai_results (...) VALUES (...)
    return id;
  }

  async logRetrieval(input: LogRetrievalInput): Promise<string> {
    const id = uuidv4();
    this.logger.debug(`[stub] retrieval_logs INSERT id=${id} topK=${input.topK}`);
    // TODO: INSERT INTO retrieval_logs (...) VALUES (...)
    return id;
  }

  async logToolCall(input: LogToolCallInput): Promise<string> {
    const id = uuidv4();
    this.logger.debug(
      `[stub] ai_tool_calls INSERT id=${id} tool=${input.toolName} status=${input.status}`,
    );
    // TODO: INSERT INTO ai_tool_calls (...) VALUES (...)
    return id;
  }
}

/**
 * Provider-agnostic LLM types.
 */

export type LlmProvider = 'gemini' | 'openai';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmCompleteOptions {
  /** Which provider to use. Defaults to env LLM_PROVIDER_DEFAULT. */
  provider?: LlmProvider;
  /** Model code; defaults to provider-specific default. */
  model?: string;
  /** Request JSON-only output (uses provider's JSON mode if available). */
  jsonMode?: boolean;
  /** Temperature; default 0.2 for deterministic structured output. */
  temperature?: number;
  /** Max output tokens; default 2048. */
  maxOutputTokens?: number;
}

export interface LlmCompleteResult {
  /** Raw response from provider (full payload). */
  rawResponse: unknown;
  /** Plain text content extracted from rawResponse. */
  text: string;
  /** If jsonMode was true, parsed JSON. Otherwise undefined. */
  parsedJson?: unknown;
  /** Token usage from provider. */
  tokenUsage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** Provider model code used. */
  modelCode: string;
  /** Provider name. */
  provider: LlmProvider;
  /** Wall-clock latency in milliseconds. */
  latencyMs: number;
}

export interface LlmEmbedOptions {
  provider?: LlmProvider;
  model?: string;
}

export interface LlmEmbedResult {
  embedding: number[];
  modelCode: string;
  provider: LlmProvider;
  tokenUsage: number;
  latencyMs: number;
}

export interface LlmProviderClient {
  readonly name: LlmProvider;
  complete(messages: LlmMessage[], options: LlmCompleteOptions): Promise<LlmCompleteResult>;
  embed(text: string, options: LlmEmbedOptions): Promise<LlmEmbedResult>;
}

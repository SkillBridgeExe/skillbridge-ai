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
  /**
   * Optional JSON Schema constraining model output (model-level structured output).
   * Gemini → `responseJsonSchema`; OpenAI → `response_format: json_schema` (strict).
   * Requires `jsonMode`. The post-hoc parser still validates regardless (defense in depth).
   * NOTE: not yet enabled by cv-review — needs a live Gemini run to confirm the provider
   * accepts the schema before relying on it.
   */
  responseSchema?: Record<string, unknown>;
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
  /**
   * Target embedding dimensionality (OpenAI `dimensions` param — Matryoshka shortening,
   * server returns UNIT-LENGTH vectors, no manual re-normalization needed). Must match the
   * pgvector column width (config `vector.dimension`). Verified June 2026: OpenAI docs.
   */
  dimensions?: number;
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

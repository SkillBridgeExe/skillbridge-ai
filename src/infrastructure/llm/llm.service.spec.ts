import { LlmService } from './llm.service';

describe('LlmService — OpenAI-only (Gemini removed)', () => {
  it('resolves to the injected OpenAI provider regardless of options.provider', async () => {
    const complete = jest.fn().mockResolvedValue({
      rawResponse: {},
      text: 'ok',
      tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      modelCode: 'gpt-5.4-mini',
      provider: 'openai',
      latencyMs: 1,
    });
    const config = { get: jest.fn(() => 'openai') };
    const openai = { name: 'openai', complete, embed: jest.fn() };
    // constructor is now (config, openai) — 2 args, no gemini param.
    const service = new LlmService(config as never, openai as never);
    const result = await service.complete([{ role: 'user', content: 'hi' }]);
    expect(complete).toHaveBeenCalled();
    expect(result.modelCode).toBe('gpt-5.4-mini');
  });

  it('falls back to openai (not gemini) when config returns no default', async () => {
    const complete = jest.fn().mockResolvedValue({
      rawResponse: {},
      text: 'ok',
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      modelCode: 'm',
      provider: 'openai',
      latencyMs: 1,
    });
    const config = { get: jest.fn(() => undefined) }; // no providerDefault configured at all
    const openai = { name: 'openai', complete, embed: jest.fn() };
    const service = new LlmService(config as never, openai as never);
    await expect(service.complete([{ role: 'user', content: 'hi' }])).resolves.toBeDefined();
    expect(complete).toHaveBeenCalled(); // did NOT throw "Unknown LLM provider: gemini"
  });
});

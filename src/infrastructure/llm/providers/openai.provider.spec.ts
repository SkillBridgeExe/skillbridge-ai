import { OpenAiProvider } from './openai.provider';

const createMock = jest.fn();
jest.mock('openai', () =>
  jest.fn().mockImplementation(() => ({ chat: { completions: { create: createMock } } })),
);

function makeProvider() {
  const config = {
    get: jest.fn((key: string) => (key === 'llm.openai.apiKey' ? 'test-key' : undefined)),
  };
  return new OpenAiProvider(config as never);
}

describe('OpenAiProvider.complete — tools', () => {
  afterEach(() => createMock.mockReset());

  it('passes tools as {type:"function",function} and parses tool_calls (JSON arguments) as toolCalls', async () => {
    createMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'c1',
                type: 'function',
                function: { name: 'resource.validate', arguments: '{"url":"https://x.dev"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: {},
    });
    const provider = makeProvider();
    const result = await provider.complete([{ role: 'user', content: 'is this link alive?' }], {
      tools: [
        {
          name: 'resource.validate',
          description: 'd',
          parameters: { type: 'object', properties: {} },
        },
      ],
    });
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [
          {
            type: 'function',
            function: {
              name: 'resource.validate',
              description: 'd',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
      }),
    );
    expect(result.toolCalls).toEqual([
      { name: 'resource.validate', args: { url: 'https://x.dev' } },
    ]);
  });

  it('toolCalls is undefined and no throw when the model answers directly (no tool_calls)', async () => {
    createMock.mockResolvedValue({
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
      usage: {},
    });
    const provider = makeProvider();
    const result = await provider.complete([{ role: 'user', content: 'q' }], {});
    expect(result.toolCalls).toBeUndefined();
    expect(result.text).toBe('hi');
  });

  it('a tool_call with unparsable arguments is dropped, not thrown', async () => {
    createMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'x', arguments: 'not json' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: {},
    });
    const provider = makeProvider();
    const result = await provider.complete([{ role: 'user', content: 'q' }], { tools: [] });
    expect(result.toolCalls).toEqual([]);
  });
});

import {
  JUDGE_SCHEMA,
  JudgedTurn,
  judgeConversation,
  resolveCvJudgeModel,
  summarizeJudgement,
} from './cv-writing-judge';

const DIMENSIONS = [
  'specificity',
  'star_shape',
  'grounded_faithfulness',
  'actionability_of_ask',
  'ats_readability',
  'voice_adherence',
  'does_not_embellish_tone',
] as const;

function makeTurn(overrides: Partial<JudgedTurn> = {}): JudgedTurn {
  return {
    turn: 1,
    specificity: 4,
    star_shape: 4,
    grounded_faithfulness: 4,
    actionability_of_ask: 4,
    ats_readability: 4,
    voice_adherence: 4,
    does_not_embellish_tone: 4,
    note: 'ổn',
    ...overrides,
  };
}

function makeClient(turns: JudgedTurn[]) {
  const create = jest.fn().mockResolvedValue({
    choices: [{ message: { content: JSON.stringify({ turns }) } }],
  });
  return { client: { chat: { completions: { create } } } as never, create };
}

describe('JUDGE_SCHEMA — shape', () => {
  const itemSchema = JUDGE_SCHEMA.properties.turns.items as unknown as {
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: boolean;
  };

  it('has all 7 CV-writing quality dimensions as properties', () => {
    for (const dim of DIMENSIONS) {
      expect(itemSchema.properties).toHaveProperty(dim);
    }
  });

  it('is OpenAI-strict: required lists every property, additionalProperties false (top + item level)', () => {
    const propNames = Object.keys(itemSchema.properties);
    expect(itemSchema.required.sort()).toEqual(propNames.sort());
    expect(itemSchema.additionalProperties).toBe(false);
    expect(JUDGE_SCHEMA.additionalProperties).toBe(false);
    expect(JUDGE_SCHEMA.required).toEqual(['turns']);
  });

  it('does NOT have a does_not_invent dimension — invention stays a deterministic gate counter, not a judge score', () => {
    expect(itemSchema.properties).not.toHaveProperty('does_not_invent');
    expect(itemSchema.required).not.toContain('does_not_invent');
  });
});

describe('judgeConversation', () => {
  it('sends one assistant-turn-indexed request and returns the parsed turns', async () => {
    const { client, create } = makeClient([makeTurn({ turn: 1 })]);
    const transcript: Array<{ role: 'user' | 'assistant'; text: string }> = [
      { role: 'user', text: 'giúp mình sửa bullet này' },
      { role: 'assistant', text: 'thử thêm một con số vào bullet nhé' },
    ];
    const turns = await judgeConversation(client, 'gpt-4o', 'FACTS...', transcript);
    expect(turns).toHaveLength(1);
    expect(turns[0].turn).toBe(1);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('retries once on a turn-count mismatch, then throws if the retry also mismatches', async () => {
    const create = jest.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ turns: [] }) } }],
    });
    const client = { chat: { completions: { create } } } as never;
    const transcript: Array<{ role: 'user' | 'assistant'; text: string }> = [
      { role: 'assistant', text: 'x' },
    ];
    await expect(judgeConversation(client, 'gpt-4o', 'FACTS', transcript)).rejects.toThrow();
    expect(create).toHaveBeenCalledTimes(2);
  });
});

describe('resolveCvJudgeModel — judge-must-differ guard', () => {
  const ORIGINAL = process.env.CV_WRITING_JUDGE_MODEL;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.CV_WRITING_JUDGE_MODEL;
    else process.env.CV_WRITING_JUDGE_MODEL = ORIGINAL;
    jest.restoreAllMocks();
  });

  it('warns (does not throw) when the resolved judge model equals the advisor model', () => {
    process.env.CV_WRITING_JUDGE_MODEL = 'gpt-4o-mini';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const model = resolveCvJudgeModel('gpt-4o-mini');
    expect(model).toBe('gpt-4o-mini');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/judge model == advisor model/);
  });

  it('stays silent when the judge model differs from the advisor model', () => {
    process.env.CV_WRITING_JUDGE_MODEL = 'gpt-4o';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    resolveCvJudgeModel('gpt-4o-mini');
    expect(warn).not.toHaveBeenCalled();
  });

  it('defaults to gpt-4o when unset, and warns if that default collides with the advisor model', () => {
    delete process.env.CV_WRITING_JUDGE_MODEL;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveCvJudgeModel('gpt-4o')).toBe('gpt-4o');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('summarizeJudgement', () => {
  it('averages each dimension correctly over a small fixture', () => {
    const all = [
      { persona: 'p1', t: makeTurn({ turn: 1, specificity: 5, voice_adherence: 3 }) },
      { persona: 'p1', t: makeTurn({ turn: 2, specificity: 3, voice_adherence: 5 }) },
    ];
    const s = summarizeJudgement(all);
    expect(s.total).toBe(2);
    expect(s.avgSpecificity).toBe(4);
    expect(s.avgVoiceAdherence).toBe(4);
    expect(s.avgStarShape).toBe(4);
    expect(s.avgGroundedFaithfulness).toBe(4);
    expect(s.avgActionabilityOfAsk).toBe(4);
    expect(s.avgAtsReadability).toBe(4);
    expect(s.avgDoesNotEmbellishTone).toBe(4);
  });

  it('returns zeros for an empty fixture (no div-by-zero)', () => {
    const s = summarizeJudgement([]);
    expect(s.total).toBe(0);
    expect(s.avgSpecificity).toBe(0);
  });

  it('surfaces the worst-scoring turns', () => {
    const all = [
      { persona: 'p1', t: makeTurn({ turn: 1 }) }, // all 4s, overall 28
      {
        persona: 'p2',
        t: makeTurn({
          turn: 1,
          specificity: 1,
          star_shape: 1,
          grounded_faithfulness: 1,
          actionability_of_ask: 1,
          ats_readability: 1,
          voice_adherence: 1,
          does_not_embellish_tone: 1,
        }),
      }, // overall 7
    ];
    const s = summarizeJudgement(all);
    expect(s.worst).toHaveLength(1);
    expect(s.worst[0].persona).toBe('p2');
  });
});

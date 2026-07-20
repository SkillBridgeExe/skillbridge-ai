import { CvBuilderChatService } from './cv-builder-chat.service';
import { CvBuilderChatFacts } from './cv-builder-chat.facts';

const FACTS: CvBuilderChatFacts = {
  target_role: 'Frontend Developer',
  cv_language: 'vi',
  sections: [{ section: 'projects', present: true, item_count: 1 }],
  focus: {
    section: 'projects',
    field_path: 'projects[0].description',
    current_text: 'Xây dựng trang web bán hàng bằng React',
    gaps: ['result'],
  },
  diagnosis: null,
};

function makePrompts() {
  return {
    render: jest.fn().mockReturnValue('rendered-user-prompt'),
    get: jest.fn((code: string) =>
      code === 'mascot_character_cvbuilder_v1'
        ? { body: 'Nhân cách cá heo CV Builder.', meta: {} }
        : { body: '', meta: { system: 'system-prompt' } },
    ),
  };
}

describe('CvBuilderChatService.turn', () => {
  it('grounds the model output and returns a grounded result', async () => {
    const prompts = makePrompts();
    const llm = {
      complete: jest.fn().mockResolvedValue({
        parsedJson: {
          message: 'Đây nhé.',
          used_facts: ['react'],
          proposed_edit: null,
          cited_field_path: null,
          suggested_next_step: null,
        },
        text: '',
        tokenUsage: {},
      }),
    };
    const service = new CvBuilderChatService(llm as never, prompts as never);
    const res = await service.turn({ question: 'mình dùng react', facts: FACTS, language: 'vi' });
    expect(res.answer_kind).toBe('grounded');
    expect(llm.complete).toHaveBeenCalledTimes(1);
  });

  it('LLM throw → deterministic honest fallback, never a 500', async () => {
    const prompts = makePrompts();
    const llm = { complete: jest.fn().mockRejectedValue(new Error('timeout')) };
    const service = new CvBuilderChatService(llm as never, prompts as never);
    const res = await service.turn({ question: 'x', facts: FACTS, language: 'vi' });
    expect(res.answer_kind).toBe('canned');
  });

  it('system prompt = base rules + CV-builder persona, in that order', async () => {
    const prompts = makePrompts();
    const llm = {
      complete: jest.fn().mockResolvedValue({
        parsedJson: {
          message: 'ok',
          used_facts: [],
          proposed_edit: null,
          cited_field_path: null,
          suggested_next_step: null,
        },
        text: '',
        tokenUsage: {},
      }),
    };
    const service = new CvBuilderChatService(llm as never, prompts as never);
    await service.turn({ question: 'giúp mình viết mô tả dự án', facts: FACTS, language: 'vi' });
    const system = (llm.complete.mock.calls[0][0] as Array<{ content: string }>)[0].content;
    expect(system).toContain('system-prompt');
    expect(system).toContain('cá heo CV Builder');
    expect(system.indexOf('system-prompt')).toBeLessThan(system.indexOf('cá heo CV Builder'));
  });

  it('never passes an assistant turn into candidateSaid — an assistant-only number cannot be echoed as grounded', async () => {
    const prompts = makePrompts();
    // The assistant previously said "300%" (e.g. an earlier grounded reply); the user never did.
    // If candidateSaid ever included assistant turns, "300%" would be licensed and the message would
    // pass the prose gate as 'grounded'. It must instead be refused as an ungrounded fabrication.
    const llm = {
      complete: jest.fn().mockResolvedValue({
        parsedJson: {
          message: 'Bạn đã tăng hiệu suất 300% nhé.',
          used_facts: [],
          proposed_edit: null,
          cited_field_path: null,
          suggested_next_step: null,
        },
        text: '',
        tokenUsage: {},
      }),
    };
    const service = new CvBuilderChatService(llm as never, prompts as never);
    const res = await service.turn({
      question: 'còn gì nữa không',
      facts: FACTS,
      language: 'vi',
      history: [{ role: 'assistant', content: 'Bạn đã tăng hiệu suất 300% trước đó rồi.' }],
    });
    expect(res.answer_kind).toBe('refusal');
  });

  it('answers a greeting from code, no LLM call, with known_state attached', async () => {
    const prompts = makePrompts();
    const llm = { complete: jest.fn() };
    const service = new CvBuilderChatService(llm as never, prompts as never);
    const res = await service.turn({ question: 'hi', facts: FACTS, language: 'vi' });
    expect(llm.complete).not.toHaveBeenCalled();
    expect(res.answer_kind).toBe('canned');
    expect(res.known_state).toBeDefined();
  });

  it('appends the ask on an advice turn where the model dropped it (ensureAskBack)', async () => {
    const prompts = makePrompts();
    // FACTS.focus already carries an unanswered 'result' gap; the question is advice-seeking
    // ('write' intent), so askDirective fires — the model's reply below carries no '?' at all.
    const llm = {
      complete: jest.fn().mockResolvedValue({
        parsedJson: {
          message: 'Gợi ý dùng động từ mạnh hơn.',
          used_facts: [],
          proposed_edit: null,
          cited_field_path: null,
          suggested_next_step: null,
        },
        text: '',
        tokenUsage: {},
      }),
    };
    const service = new CvBuilderChatService(llm as never, prompts as never);
    const res = await service.turn({
      question: 'giúp mình viết project này mạnh hơn',
      facts: FACTS,
      language: 'vi',
    });
    expect(res.answer).toContain('?'); // the ask-back was appended
    expect(res.known_state).toBeDefined();
  });

  it('known_state rides the LLM-failure fallback path too', async () => {
    const prompts = makePrompts();
    const llm = { complete: jest.fn().mockRejectedValue(new Error('timeout')) };
    const service = new CvBuilderChatService(llm as never, prompts as never);
    const res = await service.turn({ question: 'x', facts: FACTS, language: 'vi' });
    expect(res.answer_kind).toBe('canned');
    expect(res.known_state).toBeDefined();
  });
});

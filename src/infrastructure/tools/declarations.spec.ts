import { mightNeedTool, toolDeclarationsForFlow } from './declarations';

describe('toolDeclarationsForFlow', () => {
  it('returns non-empty declarations for both wired flows', () => {
    expect(toolDeclarationsForFlow('diagnosis_chat').length).toBeGreaterThan(0);
    expect(toolDeclarationsForFlow('learning_chat').length).toBeGreaterThan(0);
  });

  it('diagnosis_chat carries the wave 3 read-tools, declared with ZERO model-suppliable parameters', () => {
    const declarations = toolDeclarationsForFlow('diagnosis_chat');
    const names = declarations.map((d) => d.name);
    expect(names).toEqual(
      expect.arrayContaining(['github.enrich', 'roadmap.progress', 'interview.history']),
    );
    for (const name of ['roadmap.progress', 'interview.history']) {
      const decl = declarations.find((d) => d.name === name);
      expect(decl?.parameters).toEqual({
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      });
    }
  });

  it('returns empty for an unknown flow', () => {
    expect(toolDeclarationsForFlow('unknown_flow')).toEqual([]);
  });
});

describe('mightNeedTool', () => {
  it('diagnosis_chat: a question mentioning github → true', () => {
    expect(mightNeedTool('diagnosis_chat', 'does my github show react?')).toBe(true);
  });

  it('diagnosis_chat: a question with no tool-shaped mention → false', () => {
    expect(mightNeedTool('diagnosis_chat', 'why is my ATS score low?')).toBe(false);
    expect(mightNeedTool('diagnosis_chat', 'mình nên sửa bullet nào trước?')).toBe(false);
  });

  it('diagnosis_chat: roadmap-progress phrasings → true', () => {
    expect(mightNeedTool('diagnosis_chat', 'mình học tới đâu rồi nhỉ')).toBe(true);
    expect(mightNeedTool('diagnosis_chat', 'lộ trình của mình sao rồi')).toBe(true);
    expect(mightNeedTool('diagnosis_chat', 'tiến độ roadmap của mình ok không')).toBe(true);
  });

  it('diagnosis_chat: interview-history phrasings → true', () => {
    expect(mightNeedTool('diagnosis_chat', 'mấy buổi phỏng vấn thử của mình sao rồi')).toBe(true);
    expect(mightNeedTool('diagnosis_chat', 'how did my last mock interview go')).toBe(true);
  });

  it('learning_chat: a question containing a URL → true', () => {
    expect(mightNeedTool('learning_chat', 'is https://x.dev/course still alive?')).toBe(true);
  });

  it('learning_chat: a question with no link mention → false', () => {
    expect(mightNeedTool('learning_chat', 'what should I learn after Docker?')).toBe(false);
  });

  it('unknown flow → false', () => {
    expect(mightNeedTool('unknown_flow', 'https://x.dev github repo')).toBe(false);
  });
});

describe('mightNeedTool — English coverage for the wave 3 hints (review MINOR)', () => {
  it('english learning-progress phrasings reach the roadmap tool', () => {
    expect(mightNeedTool('diagnosis_chat', 'how is my learning progress going?')).toBe(true);
    expect(mightNeedTool('diagnosis_chat', 'how far along am I with my courses?')).toBe(true);
  });
});

import { mightNeedTool, toolDeclarationsForFlow } from './declarations';

describe('toolDeclarationsForFlow', () => {
  it('returns non-empty declarations for both wired flows', () => {
    expect(toolDeclarationsForFlow('diagnosis_chat').length).toBeGreaterThan(0);
    expect(toolDeclarationsForFlow('learning_chat').length).toBeGreaterThan(0);
  });

  it('returns empty for an unknown flow', () => {
    expect(toolDeclarationsForFlow('unknown_flow')).toEqual([]);
  });
});

describe('mightNeedTool', () => {
  it('diagnosis_chat: a question mentioning github → true', () => {
    expect(mightNeedTool('diagnosis_chat', 'does my github show react?')).toBe(true);
  });

  it('diagnosis_chat: a question with no github/repo mention → false', () => {
    expect(mightNeedTool('diagnosis_chat', 'why is my ATS score low?')).toBe(false);
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

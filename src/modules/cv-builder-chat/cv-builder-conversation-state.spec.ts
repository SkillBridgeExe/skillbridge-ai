import {
  buildTurnContext,
  extractConversationState,
  routeIntent,
} from './cv-builder-conversation-state';
import { CvBuilderChatFacts } from './cv-builder-chat.facts';

const user = (content: string) => ({ role: 'user' as const, content });
const bot = (content: string) => ({ role: 'assistant' as const, content });

const FACTS: CvBuilderChatFacts = {
  target_role: 'Backend Developer',
  cv_language: 'vi',
  sections: [{ section: 'projects', present: true, item_count: 1 }],
  focus: {
    section: 'projects',
    field_path: 'cvbuilder:projects[0].bullets[0]',
    current_text: 'Xây dựng hệ thống backend cho ứng dụng thương mại điện tử',
    gaps: ['result', 'tech'],
  },
};

const FACTS_NO_FOCUS: CvBuilderChatFacts = { ...FACTS, focus: null };

// an assistant turn phrased to fire ASKED_GAP_RE's `result` branch — Task 2.2's real ASK_COPY table
// must phrase its asks the same way or the capture-consumes-ask mechanism silently breaks.
const ASKED_RESULT = bot('Dự án đó bạn đo được kết quả gì chưa?');

describe('extractConversationState — capture discipline (WRONG capture is the only forbidden failure)', () => {
  it('captures the gap the user just answered (consumes the ask, one-shot)', () => {
    const history = [user('mình nên viết gì cho project?'), ASKED_RESULT];
    const s = extractConversationState(history, 'giảm load 40%');
    expect(s.answered_gaps).toContainEqual({ field_path: expect.any(String), gap: 'result' });
    expect(s.asked_gap).toBeNull();
  });

  it('WRONG-capture guard: a dodge that does not answer the asked gap leaves it outstanding', () => {
    const history = [user('mình nên viết gì cho project?'), ASKED_RESULT];
    const s = extractConversationState(history, 'ok cảm ơn nha');
    expect(s.answered_gaps).not.toContainEqual(expect.objectContaining({ gap: 'result' }));
    expect(s.asked_gap).toEqual({ field_path: expect.any(String), gap: 'result' });
  });

  it('one-shot: only the turn IMMEDIATELY after the ask gets a capture attempt', () => {
    const history = [
      user('mình nên viết gì cho project?'),
      ASKED_RESULT,
      user('để mình nghĩ đã'), // dodge — does not consume
      bot('ok, từ từ cũng được'), // not another ask
    ];
    // a later turn stating a metric should NOT retroactively consume the stale ask
    const s = extractConversationState(history, 'giảm load 40%');
    expect(s.answered_gaps).not.toContainEqual(expect.objectContaining({ gap: 'result' }));
    expect(s.asked_gap).toEqual({ field_path: expect.any(String), gap: 'result' });
  });

  it('an outstanding ask is sticky across a non-asking assistant turn', () => {
    const history = [user('mình nên viết gì cho project?'), ASKED_RESULT, bot('ok')];
    const s = extractConversationState(history, 'chưa biết nữa');
    expect(s.asked_gap).toEqual({ field_path: expect.any(String), gap: 'result' });
  });

  it('captures a tech-gap answer ("dùng React với Node") after a tech-ask', () => {
    const history = [bot('Bạn dùng công nghệ gì cho phần này vậy?')];
    const s = extractConversationState(history, 'dùng React với Node');
    expect(s.answered_gaps).toContainEqual({ field_path: expect.any(String), gap: 'tech' });
    expect(s.asked_gap).toBeNull();
  });

  it('captures an action-gap answer after an action-ask', () => {
    const history = [bot('Bạn đã làm gì trong dự án đó vậy?')];
    const s = extractConversationState(history, 'mình xây dựng API backend');
    expect(s.answered_gaps).toContainEqual({ field_path: expect.any(String), gap: 'action' });
  });

  it('does NOT capture result when the user dodges with a duration/deferral (bare time units are not metrics)', () => {
    const history = [user('mình nên viết gì cho project?'), ASKED_RESULT];
    const s = extractConversationState(history, 'chưa có số, tầm 2 tuần nữa mình bổ sung');
    expect(s.answered_gaps).not.toContainEqual(expect.objectContaining({ gap: 'result' }));
  });

  it('does NOT capture tech when the user dodges by naming a person', () => {
    const history = [bot('Bạn dùng công nghệ gì cho phần này vậy?')];
    const s = extractConversationState(history, 'chưa, để hỏi Nam đã');
    expect(s.answered_gaps).not.toContainEqual(expect.objectContaining({ gap: 'tech' }));
  });

  it('does NOT capture action when the user dodges', () => {
    const history = [bot('Bạn đã làm gì trong dự án đó vậy?')];
    const s = extractConversationState(history, 'thôi mình tạo cái khác sau');
    expect(s.answered_gaps).not.toContainEqual(expect.objectContaining({ gap: 'action' }));
  });

  it('a "chưa" hedge inside a genuine answer is NOT swallowed as a dodge (result IS captured)', () => {
    const history = [user('mình nên viết gì cho project?'), ASKED_RESULT];
    const s = extractConversationState(history, 'trước đây chưa đo nhưng giờ giảm 40%');
    expect(s.answered_gaps).toContainEqual({ field_path: expect.any(String), gap: 'result' });
    expect(s.asked_gap).toBeNull();
  });

  it('a compound word containing "thôi" ("thôi thúc") is not misread as the dodge particle', () => {
    const history = [bot('Bạn dùng công nghệ gì cho phần này vậy?')];
    const s = extractConversationState(history, 'điều đó thôi thúc mình học React');
    expect(s.answered_gaps).toContainEqual({ field_path: expect.any(String), gap: 'tech' });
  });

  it("a person's name is NOT captured as a tech answer (tech capture requires a known-tech gazetteer hit)", () => {
    const history = [bot('Bạn dùng công nghệ gì cho phần này vậy?')];
    const s = extractConversationState(history, 'thật ra Nam là người làm phần đó');
    expect(s.answered_gaps).not.toContainEqual(expect.objectContaining({ gap: 'tech' }));
  });

  it('a restated target role is captured (informational)', () => {
    const s = extractConversationState([], 'mình đang nhắm vị trí Backend Developer');
    expect(s.target_role).toBe('Backend Developer');
  });

  it('active_field_path is left null by extraction alone (no honest text source for an opaque id)', () => {
    const history = [user('mình nên viết gì cho project?'), ASKED_RESULT];
    const s = extractConversationState(history, 'giảm load 40%');
    expect(s.active_field_path).toBeNull();
  });
});

describe('routeIntent — deterministic pre-LLM router', () => {
  it('routes "viết bullet này ngắn lại" → shorten', () => {
    expect(routeIntent('viết bullet này ngắn lại giúp mình', FACTS)).toBe('shorten');
  });

  it.each(['chào bạn', 'hello!', 'Xin chào', 'alo'])('greeting: %s', (q) => {
    expect(routeIntent(q, FACTS)).toBe('greeting');
  });

  it.each(['cảm ơn nhé!', 'thanks bạn nhiều', 'tạm biệt'])('thanks: %s', (q) => {
    expect(routeIntent(q, FACTS)).toBe('thanks');
  });

  it.each(['bạn là ai', 'bạn làm được gì', 'who are you?'])('meta: %s', (q) => {
    expect(routeIntent(q, FACTS)).toBe('meta');
  });

  it('a meta opener carrying a real question is NOT canned (length cap + DOMAIN_HINT)', () => {
    expect(
      routeIntent('bạn là ai mà sửa được bullet dự án của mình vậy, giải thích coi', FACTS),
    ).toBe('explain');
  });

  it('DOMAIN_HINT test: a greeting that also asks a real CV question reaches the LLM, not canned', () => {
    expect(routeIntent('hi, can you fix my project bullet?', FACTS)).not.toBe('greeting');
  });

  it('routes "thêm số liệu vào bullet này" → add_metric', () => {
    expect(routeIntent('thêm số liệu vào bullet này giúp mình', FACTS)).toBe('add_metric');
  });

  it('routes "tại sao bullet này yếu" → explain', () => {
    expect(routeIntent('tại sao bullet này bị đánh giá yếu vậy', FACTS)).toBe('explain');
  });

  it('routes "mình nên viết gì cho phần này" → ask_what_to_write when a field is focused', () => {
    expect(routeIntent('mình nên viết gì cho phần này', FACTS)).toBe('ask_what_to_write');
  });

  it('the same question falls back to write when nothing is focused', () => {
    expect(routeIntent('mình nên viết gì cho phần này', FACTS_NO_FOCUS)).toBe('write');
  });

  it('routes "bạn có nhớ lúc nãy nói gì không" → recall', () => {
    expect(routeIntent('bạn có nhớ lúc nãy nói gì không', FACTS)).toBe('recall');
  });

  it('an unmatched CV request falls through to write (the catch-all)', () => {
    expect(routeIntent('giúp mình cải thiện đoạn này với', FACTS)).toBe('write');
  });
});

describe('buildTurnContext — the shared entry point', () => {
  it('a greeting is code-answered (canned non-null), never reaches the LLM', () => {
    const ctx = buildTurnContext(FACTS, [], 'hello');
    expect(ctx.canned).not.toBeNull();
    expect(ctx.intent).toBe('greeting');
  });

  it('a real CV question is never canned and ask is always null in this task', () => {
    const ctx = buildTurnContext(FACTS, [], 'viết lại bullet này giúp mình');
    expect(ctx.canned).toBeNull();
    expect(ctx.ask).toBeNull();
  });

  it('defaults active_field_path from facts.focus when history carries no mention', () => {
    const ctx = buildTurnContext(FACTS, [], 'viết lại bullet này giúp mình');
    expect(ctx.state.active_field_path).toBe('cvbuilder:projects[0].bullets[0]');
  });

  it('contextBlock carries the known state for the prompt', () => {
    const ctx = buildTurnContext(FACTS, [], 'viết lại bullet này giúp mình');
    expect(ctx.contextBlock).toContain('cvbuilder:projects[0].bullets[0]');
  });
});

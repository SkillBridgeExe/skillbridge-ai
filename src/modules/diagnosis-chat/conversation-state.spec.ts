import {
  askDirective,
  buildTurnContext,
  extractConversationState,
  routeIntent,
} from './conversation-state';
import { DiagnosisFacts } from './diagnosis-grounding';

const FACTS: DiagnosisFacts = {
  overall_score: 58,
  ats_score: 64,
  dimensions: [{ key: 'action_verbs', score20: 9, rationale: 'Bullet chưa có động từ mạnh.' }],
  top_summary: { prioritized_actions: ['Thêm số liệu vào thành tích'] },
  gap_items: [],
};

const FACTS_WITH_MATCHES: DiagnosisFacts = {
  ...FACTS,
  other_matches: [{ jd_title: 'Frontend Developer', overall_score: 72, top_gaps: ['React'] }],
};

const user = (content: string) => ({ role: 'user' as const, content });
const bot = (content: string) => ({ role: 'assistant' as const, content });

describe('extractConversationState — deterministic memory over the whole window', () => {
  it('reads the target role out of the TRI-NHO opener (role + deadline in one message)', () => {
    const s = extractConversationState(
      [],
      'Mình đang nhắm vị trí AI Engineer và mình chỉ còn đúng 2 tuần trước deadline nộp. Nên làm gì trước?',
    );
    expect(s.target_role).toBe('AI Engineer');
    expect(s.deadline).toBe('2 tuần');
  });

  it('accepts a lowercase chat-register role when it contains a role word', () => {
    expect(extractConversationState([], 'mình nhắm backend dev thôi').target_role).toBe(
      'backend dev',
    );
  });

  it('accepts "ứng tuyển vào …" and "muốn làm …"', () => {
    expect(extractConversationState([], 'em ứng tuyển vào Data Analyst ạ').target_role).toBe(
      'Data Analyst',
    );
    expect(extractConversationState([], 'mình muốn làm tester').target_role).toBe('tester');
  });

  it('rejects question-shaped and junk captures (fail-soft to null, never a wrong role)', () => {
    for (const q of [
      'vị trí này có hợp với mình không',
      'vị trí nào hợp mình nhất',
      'mình không biết muốn làm gì giờ',
      'mình muốn làm cho xong CV đã',
    ]) {
      expect(extractConversationState([], q).target_role).toBeNull();
    }
  });

  it('a role stated 30 messages ago survives (the platform passes the wide window)', () => {
    const history = [
      user('Mình nhắm vị trí AI Engineer nhé'),
      ...Array.from({ length: 30 }, (_, i) => bot(`trả lời ${i}`)),
    ];
    expect(extractConversationState(history, 'giờ sửa gì trước?').target_role).toBe('AI Engineer');
  });

  it('the LATER statement wins when the candidate changes their mind', () => {
    const history = [user('mình định nhắm Data Analyst'), bot('ok')];
    const s = extractConversationState(history, 'thôi mình chuyển sang nhắm Backend Developer rồi');
    expect(s.target_role).toBe('Backend Developer');
  });

  it('reads deadline variants: "trước cuối tháng 8", "tuần sau", "3 days left"', () => {
    expect(extractConversationState([], 'mình phải nộp trước cuối tháng 8').deadline).toBe(
      'cuối tháng 8',
    );
    expect(extractConversationState([], 'tuần sau mình phỏng vấn rồi').deadline).toBe('tuần sau');
    expect(extractConversationState([], 'only 3 days left for me').deadline).toBe('3 days');
  });

  it('remembers the advisor already ASKED for role/deadline (never nag twice)', () => {
    const s = extractConversationState(
      [bot('Nghe ổn đó. Bạn đang nhắm vị trí nào vậy?'), user('chưa biết nữa')],
      'vậy giờ sao',
    );
    expect(s.asked_role).toBe(true);
    expect(s.asked_deadline).toBe(false);
  });
});

describe('routeIntent — deterministic pre-LLM router (misroute = worst failure, so fail to LLM)', () => {
  it.each(['chào bạn', 'hello!', 'Xin chào', 'alo'])('greeting: %s', (q) => {
    expect(routeIntent(q, FACTS)).toBe('greeting');
  });

  it('a greeting CARRYING a real question is NOT canned', () => {
    expect(routeIntent('chào bạn, CV mình sao rồi', FACTS)).toBe('advice');
  });

  it.each(['cảm ơn nhé!', 'thanks bạn nhiều', 'tạm biệt'])('thanks: %s', (q) => {
    expect(routeIntent(q, FACTS)).toBe('thanks');
  });

  it('a bare continue ("ok rồi sao nữa") is NOT thanks — it must reach the LLM', () => {
    expect(routeIntent('ok rồi sao nữa', FACTS)).toBe('advice');
  });

  it.each(['bạn là ai', 'bạn làm được gì', 'who are you?'])('meta: %s', (q) => {
    expect(routeIntent(q, FACTS)).toBe('meta');
  });

  it('a meta opener with a real payload is NOT canned (length cap)', () => {
    expect(routeIntent('bạn là ai mà chấm CV mình có 58 điểm vậy, giải thích rõ coi', FACTS)).toBe(
      'advice',
    );
  });

  it('recall: "vừa nãy bạn nói gì ấy nhỉ" / "bạn có nhớ mình nói vị trí gì không"', () => {
    expect(routeIntent('vừa nãy bạn nói gì ấy nhỉ?', FACTS)).toBe('recall');
    expect(routeIntent('bạn có nhớ mình nhắm vị trí gì không?', FACTS)).toBe('recall');
  });

  it('compare_jd ONLY when other_matches exist; otherwise a normal advice turn', () => {
    expect(routeIntent('JD nào hợp mình nhất?', FACTS_WITH_MATCHES)).toBe('compare_jd');
    expect(routeIntent('JD nào hợp mình nhất?', FACTS)).toBe('advice');
  });

  it('the LAC-DE mixed opener goes to the LLM, never canned', () => {
    expect(
      routeIntent('bạn có biết học React ở đâu rẻ không, mà thôi CV mình sao rồi', FACTS),
    ).toBe('advice');
  });
});

describe('askDirective — the needs_detail condition, computed by code', () => {
  it('MO-HO opener (no role known, advice-seeking) → ask role', () => {
    const s = extractConversationState([], 'mình không biết bắt đầu từ đâu luôn');
    expect(askDirective(s, 'advice', 'mình không biết bắt đầu từ đâu luôn')).toBe('role');
  });

  it('role known → next missing thing is the deadline (planning question)', () => {
    const s = extractConversationState([user('mình nhắm vị trí AI Engineer')], 'nên học gì trước?');
    expect(askDirective(s, 'advice', 'nên học gì trước?')).toBe('deadline');
  });

  it('both known → no question', () => {
    const s = extractConversationState(
      [user('mình nhắm vị trí AI Engineer, còn 2 tuần nữa nộp')],
      'nên làm gì trước?',
    );
    expect(askDirective(s, 'advice', 'nên làm gì trước?')).toBeNull();
  });

  it('already asked once and they did not answer → never nag again', () => {
    const s = extractConversationState(
      [bot('Bạn đang nhắm vị trí nào vậy?'), user('kệ đi, nói tiếp đi')],
      'nên sửa gì trước?',
    );
    expect(askDirective(s, 'advice', 'nên sửa gì trước?')).toBe('deadline');
    expect(
      askDirective({ ...s, deadline: '2 tuần', asked_deadline: false }, 'advice', 'nên sửa gì?'),
    ).toBeNull();
  });

  it('a definitional question gets NO ask — asking there is noise, not care', () => {
    const s = extractConversationState([], 'điểm ATS nghĩa là gì vậy?');
    expect(askDirective(s, 'advice', 'điểm ATS nghĩa là gì vậy?')).toBeNull();
  });

  it('non-advice intents never ask', () => {
    const s = extractConversationState([], 'vừa nãy bạn nói nên sửa gì ấy nhỉ');
    expect(askDirective(s, 'recall', 'vừa nãy bạn nói nên sửa gì ấy nhỉ')).toBeNull();
  });
});

describe('buildTurnContext — the single entry point the service and harnesses share', () => {
  it('greeting → canned Vietnamese copy, no LLM needed', () => {
    const ctx = buildTurnContext(FACTS, [], 'chào bạn', 'vi');
    expect(ctx.intent).toBe('greeting');
    expect(ctx.canned).toContain('chẩn đoán CV');
  });

  it('greeting in English → canned English copy', () => {
    const ctx = buildTurnContext(FACTS, [], 'hello', 'en');
    expect(ctx.canned).toContain('CV diagnosis');
  });

  it('advice turn: context block shows Known lines and the ask-role directive', () => {
    const ctx = buildTurnContext(FACTS, [], 'mình không biết bắt đầu từ đâu luôn', 'vi');
    expect(ctx.canned).toBeNull();
    expect(ctx.contextBlock).toContain('Target role: (not stated yet)');
    expect(ctx.contextBlock).toContain('ONE short question asking which role');
  });

  it('once the role is known the block carries it and stops asking for it', () => {
    const ctx = buildTurnContext(
      FACTS,
      [user('mình nhắm vị trí AI Engineer và chỉ còn 2 tuần')],
      'nên làm gì trước?',
      'vi',
    );
    expect(ctx.contextBlock).toContain('Target role: AI Engineer');
    expect(ctx.contextBlock).toContain('Time budget/deadline: 2 tuần');
    expect(ctx.contextBlock).not.toContain('asking which role');
    expect(ctx.contextBlock).toContain('Weave the Known lines');
  });

  it('recall turn gets its directive', () => {
    const ctx = buildTurnContext(FACTS, [], 'vừa nãy bạn nói gì ấy nhỉ?', 'vi');
    expect(ctx.intent).toBe('recall');
    expect(ctx.contextBlock).toContain('already said in the Recent conversation');
  });

  it('compare turn gets its directive', () => {
    const ctx = buildTurnContext(FACTS_WITH_MATCHES, [], 'JD nào hợp mình nhất?', 'vi');
    expect(ctx.intent).toBe('compare_jd');
    expect(ctx.contextBlock).toContain('cited_other_match_index');
  });
});

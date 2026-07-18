import {
  askDirective,
  ensureAskBack,
  buildTurnContext,
  coveredGapNames,
  deadlineSpanDays,
  deadlineStale,
  extractConversationState,
  factsForIntent,
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

describe('memory verbs — what_you_know / forget / remember (Wave 2, code-routed)', () => {
  it.each(['bạn nhớ gì về mình?', 'bạn đang nhớ những gì?', 'what do you know about me?'])(
    'what_you_know: %s',
    (q) => {
      expect(routeIntent(q, FACTS)).toBe('what_you_know');
    },
  );

  it.each([
    'quên deadline đi',
    'quên vị trí đi nha',
    'quên hết những gì mình nói đi',
    'xóa thời hạn giùm mình',
  ])('forget: %s', (q) => {
    expect(routeIntent(q, FACTS)).toBe('forget');
  });

  it.each([
    'nhớ giùm mình: mình nhắm vị trí Backend Intern',
    'nhớ giùm là mình chỉ còn 3 ngày nữa nhé',
  ])('remember (a value was actually captured): %s', (q) => {
    expect(routeIntent(q, FACTS)).toBe('remember');
  });

  it('anti-misroute: a forget verb CARRYING a real question falls to the LLM', () => {
    expect(routeIntent('quên deadline đi, còn CV thì sửa sao?', FACTS)).toBe('advice');
  });

  it('anti-misroute: a remember imperative with NO capturable value falls to the LLM', () => {
    expect(routeIntent('nhớ kỹ là JD này cần Docker nhé', FACTS)).toBe('advice');
  });

  it('anti-misroute: asking about a SPECIFIC remembered thing stays recall (unchanged)', () => {
    expect(routeIntent('bạn có nhớ mình nhắm vị trí gì không?', FACTS)).toBe('recall');
  });

  it('anti-misroute: "bạn biết gì về ngành data?" is a domain question, not a mirror request', () => {
    expect(routeIntent('bạn biết gì về ngành data?', FACTS)).toBe('advice');
  });

  it('FORGET nullifies durably on every re-scan (state is re-derived per turn)', () => {
    const history = [user('Mình nhắm vị trí AI Engineer nhé'), bot('ok'), user('quên vị trí đi')];
    expect(extractConversationState(history, 'giờ sao?').target_role).toBeNull();
  });

  it('FORGET must not re-capture the role from the forget sentence itself', () => {
    expect(extractConversationState([], 'quên vị trí AI Engineer đi nha').target_role).toBeNull();
  });

  it('FORGET is field-scoped: dropping the deadline keeps the role', () => {
    const history = [
      user('Mình nhắm vị trí AI Engineer nhé'),
      user('mình còn đúng 2 tuần nữa'),
      user('quên thời hạn đi'),
    ];
    const s = extractConversationState(history, 'giờ sao?');
    expect(s.target_role).toBe('AI Engineer');
    expect(s.deadline).toBeNull();
  });

  it('a TANGLED forget attempt never re-captures the field it tried to erase (probe 2026-07-18)', () => {
    // parseForgetCommand DECLINES these (mixed payload / verb mid-sentence) — the extractor
    // must fail toward "don't capture": asserting the forgotten value as newly-Known is the
    // one forbidden failure (it rides into the prompt's trust-it block AND known_state).
    expect(
      extractConversationState([], 'quên vị trí Data Analyst và sửa CV giúp mình với').target_role,
    ).toBeNull();
    expect(
      extractConversationState([], 'bạn giúp mình quên vị trí Data Analyst đi nha').target_role,
    ).toBeNull();
    expect(
      extractConversationState([], 'bạn giúp mình quên cái deadline 3 ngày kia đi').deadline,
    ).toBeNull();
  });

  it('a tangled forget is DECLINED (old value kept), and a clean forget afterwards still works', () => {
    const history = [
      user('Mình nhắm vị trí AI Engineer nhé'),
      user('quên vị trí Data Analyst và sửa CV giúp mình với'),
    ];
    expect(extractConversationState(history, 'giờ sao?').target_role).toBe('AI Engineer');
    expect(
      extractConversationState([...history, user('quên vị trí đi')], 'giờ sao?').target_role,
    ).toBeNull();
  });

  it('"đừng quên ..." is the OPPOSITE speech act (remember) — capture still works', () => {
    expect(
      extractConversationState([], 'đừng quên là mình nhắm vị trí Data Analyst nhé').target_role,
    ).toBe('Data Analyst');
  });

  it('a LATER statement after a forget wins again (later-wins is preserved)', () => {
    const history = [
      user('mình định nhắm Data Analyst'),
      user('quên mục tiêu đi'),
      user('thôi mình nhắm Backend Developer'),
    ];
    expect(extractConversationState(history, 'ok?').target_role).toBe('Backend Developer');
  });

  it('what_you_know echoes the state verbatim and never reads as an ask to the history scanner', () => {
    const history = [user('Mình nhắm vị trí AI Engineer nhé'), user('mình còn đúng 2 tuần nữa')];
    const ctx = buildTurnContext(FACTS, history, 'bạn nhớ gì về mình?', 'vi');
    expect(ctx.intent).toBe('what_you_know');
    expect(ctx.canned).toContain('AI Engineer');
    expect(ctx.canned).toContain('2 tuần');
    // Replayed into history as ASSISTANT text: it must not register as "already asked",
    // or the ask-back directive dies for the rest of the thread. Uses the REAL regexes.
    const replay = extractConversationState([bot(ctx.canned as string)], 'x');
    expect(replay.asked_role).toBe(false);
    expect(replay.asked_deadline).toBe(false);
  });

  it('what_you_know with nothing known is honest and digit-free', () => {
    const ctx = buildTurnContext(FACTS, [], 'bạn nhớ gì về mình?', 'vi');
    expect(ctx.canned).not.toMatch(/\d/);
    expect(ctx.canned).toContain('chưa');
  });

  it('forget echoes the FIELD name, never the forgotten value, and the state is already nullified THIS turn', () => {
    const history = [user('mình còn đúng 2 tuần nữa')];
    const ctx = buildTurnContext(FACTS, history, 'quên thời hạn đi', 'vi');
    expect(ctx.intent).toBe('forget');
    expect(ctx.canned).toContain('Đã quên');
    expect(ctx.canned).not.toMatch(/\d/);
    expect(ctx.state.deadline).toBeNull();
  });

  it('remember acks the captured value verbatim', () => {
    const ctx = buildTurnContext(FACTS, [], 'nhớ giùm mình: mình nhắm vị trí Backend Intern', 'vi');
    expect(ctx.intent).toBe('remember');
    expect(ctx.canned).toContain('Backend Intern');
    expect(ctx.state.target_role).toBe('Backend Intern');
  });

  it('english variants compose in english', () => {
    const ctx = buildTurnContext(
      FACTS,
      [user('Mình nhắm vị trí AI Engineer nhé')],
      'what do you know about me?',
      'en',
    );
    expect(ctx.canned).toContain('AI Engineer');
    expect(ctx.canned).not.toContain('Mình đang nhớ');
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

// ── Regression: adversarial probe findings (07-16). Every case below SHIPPED a wrong Known or a
// nag loop before the guards existed — none of these is hypothetical. ──
describe('coveredGapNames + anti-repetition directive (measured: 6/25 turns re-recited the list)', () => {
  const FACTS_WITH_GAPS: DiagnosisFacts = {
    ...FACTS,
    gap_items: [
      { requirement_id: 'g1', display_name: 'Machine Learning' },
      { requirement_id: 'g2', display_name: 'Statistics' },
    ] as DiagnosisFacts['gap_items'],
  };

  it('empty history → nothing covered, no coverage lines, no directive', () => {
    expect(coveredGapNames(FACTS_WITH_GAPS, [])).toEqual([]);
    const ctx = buildTurnContext(FACTS_WITH_GAPS, [], 'nên làm gì trước?', 'vi');
    expect(ctx.contextBlock).not.toContain('Already advised');
    expect(ctx.contextBlock).not.toContain('Do NOT restate');
  });

  it('a gap the ASSISTANT named (any case) counts as covered; user turns never do', () => {
    const history = [
      user('Machine Learning với Statistics thì học cái nào?'),
      bot('Ưu tiên machine learning trước vì đây là gap lớn nhất.'),
    ];
    expect(coveredGapNames(FACTS_WITH_GAPS, history)).toEqual(['Machine Learning']);
  });

  it('after advising one gap, the context names it, offers the fresh ones, and forbids restating', () => {
    const history = [
      user('nên làm gì?'),
      bot('Ưu tiên Machine Learning trước, đây là khoảng trống lớn nhất.'),
    ];
    const ctx = buildTurnContext(FACTS_WITH_GAPS, history, 'rồi sao nữa?', 'vi');
    expect(ctx.contextBlock).toContain(
      'Already advised on (by you, earlier in this conversation): Machine Learning',
    );
    expect(ctx.contextBlock).toContain('Not yet mentioned from FACTS: Statistics');
    expect(ctx.contextBlock).toContain('Do NOT restate');
    expect(ctx.contextBlock).toContain('open ONE item from "Not yet mentioned"');
  });

  it('when every gap has been named, the directive pivots to going deeper instead', () => {
    const history = [user('nên làm gì?'), bot('Machine Learning trước, Statistics ngay sau.')];
    const ctx = buildTurnContext(FACTS_WITH_GAPS, history, 'còn gì nữa không?', 'vi');
    expect(ctx.contextBlock).toContain('(nothing left — everything has been named)');
    expect(ctx.contextBlock).toContain(
      'go ONE level deeper and more concrete on the most important one',
    );
  });

  // Adversarial review 2026-07-17: the taxonomy carries one-letter display names ("R", "C") and
  // a bare includes() found them inside ordinary prose — every "c" in "trước" marked the C gap
  // as advised, so the directive steered the model AWAY from a gap it never opened.
  it('one-letter gap names match only as whole words, never inside prose', () => {
    const FACTS_SHORT_NAMES: DiagnosisFacts = {
      ...FACTS,
      gap_items: [
        { requirement_id: 'g1', display_name: 'R' },
        { requirement_id: 'g2', display_name: 'C' },
      ] as DiagnosisFacts['gap_items'],
    };
    // Prose full of incidental r/c letters — neither gap has been advised.
    expect(coveredGapNames(FACTS_SHORT_NAMES, [bot('Bạn nên sửa bullet trước đã nhé.')])).toEqual(
      [],
    );
    // A real standalone mention still counts (case-insensitive).
    expect(coveredGapNames(FACTS_SHORT_NAMES, [bot('Bạn nên học ngôn ngữ R trước.')])).toEqual([
      'R',
    ]);
  });

  it('when role or deadline is known on an advice turn, the directive orders a demonstrated recall (Wave 1)', () => {
    const ctx = buildTurnContext(
      FACTS,
      [user('mình nhắm vị trí AI Engineer, còn 2 tuần nữa nộp')],
      'nên làm gì trước?',
      'vi',
    );
    expect(ctx.contextBlock).toContain('demonstrate the memory');
  });

  it('no known state → no recall directive (nothing to demonstrate)', () => {
    const ctx = buildTurnContext(FACTS, [], 'nên làm gì trước?', 'vi');
    expect(ctx.contextBlock).not.toContain('demonstrate the memory');
  });

  it('regex metacharacters in a display name (C++) neither crash nor overmatch', () => {
    const FACTS_CPP: DiagnosisFacts = {
      ...FACTS,
      gap_items: [{ requirement_id: 'g1', display_name: 'C++' }] as DiagnosisFacts['gap_items'],
    };
    expect(coveredGapNames(FACTS_CPP, [bot('Bạn nên học C++ trước.')])).toEqual(['C++']);
    expect(coveredGapNames(FACTS_CPP, [bot('Bạn nên học C trước.')])).toEqual([]);
  });
});

describe('extractConversationState — adversarial hardening', () => {
  it('negation / hypothetical / deliberation / someone-else NEVER become a Known role', () => {
    for (const q of [
      'mình KHÔNG nhắm vị trí Data Analyst nữa',
      'mình không nhắm Data Analyst nữa đâu',
      'nếu mình nhắm vị trí Tester thì sao?',
      'bạn nghĩ mình có nên nhắm vị trí AI Engineer không?',
      'bạn mình nhắm vị trí DevOps còn mình thì chưa biết',
      'mình muốn làm ở HN',
      'mình muốn làm mai mối cho vui',
    ]) {
      expect(extractConversationState([], q).target_role).toBeNull();
    }
  });

  it('a duration plan / a past event / a non-time count are NOT deadlines', () => {
    for (const q of [
      'mình cần 2 tuần để học Docker',
      'còn 3 môn nữa là tốt nghiệp',
      '2 tuần trước mình có phỏng vấn',
    ]) {
      expect(extractConversationState([], q).deadline).toBeNull();
    }
  });

  it('a BARE reply right after the advisor asked the role IS the role ("chắc là data analyst quá")', () => {
    const asked = bot('Bạn đang nhắm vị trí nào vậy?');
    expect(extractConversationState([asked, user('AI Engineer')], 'vậy giờ sao?').target_role).toBe(
      'AI Engineer',
    );
    expect(
      extractConversationState([asked, user('chắc là data analyst quá')], 'ok').target_role,
    ).toBe('data analyst');
    expect(
      extractConversationState([asked, user('kệ đi, nói tiếp đi')], 'ok').target_role,
    ).toBeNull();
  });

  it('asked_role is detected even when the model phrases the ask WITHOUT "vị trí" (nag-loop killer)', () => {
    const s = extractConversationState(
      [bot('Bạn nên sửa bullet trước. Bạn đang hướng tới công việc nào vậy?'), user('vậy sửa sao')],
      'vậy nên sửa gì trước đây',
    );
    expect(s.asked_role).toBe(true);
    expect(askDirective(s, 'advice', 'vậy nên sửa gì trước đây')).not.toBe('role');
  });

  it('the canned greeting/meta strings in history never set asked_role/asked_deadline', () => {
    const greet = buildTurnContext(FACTS, [], 'chào bạn', 'vi').canned as string;
    const meta = buildTurnContext(FACTS, [], 'bạn là ai', 'vi').canned as string;
    const s = extractConversationState([bot(greet), user('ừ'), bot(meta)], 'nên làm gì trước?');
    expect(s.asked_role).toBe(false);
    expect(s.asked_deadline).toBe(false);
  });
});

describe('routeIntent — adversarial hardening', () => {
  it('a meta opener carrying THEIR score is a real question, not canned meta', () => {
    expect(routeIntent('bạn là ai mà chấm CV mình có 58 điểm vậy', FACTS)).toBe('advice');
  });

  it('teencode thanks is canned; bare acks and continues are not', () => {
    expect(routeIntent('cám ơn bot nhìu', FACTS)).toBe('thanks');
    for (const q of ['ok', 'ừ', 'uk', 'đc', 'vâng', '?', '...']) {
      expect(routeIntent(q, FACTS)).toBe('advice');
    }
  });
});

describe('ensureAskBack — the ask-back backstop (model obeyed the Directive 1/4 turns, measured)', () => {
  it('appends the standard question when the served answer has none', () => {
    const out = ensureAskBack('Bạn nên sửa bullet trước.', 'role', 'vi');
    expect(out).toContain('Bạn nên sửa bullet trước.');
    expect(out).toContain('nhắm vị trí nào');
    expect(out.includes('?')).toBe(true);
  });

  it('never stacks a second question onto an answer that already asks one', () => {
    const answered = 'Sửa bullet trước nhé. Bạn đang nhắm vị trí nào?';
    expect(ensureAskBack(answered, 'role', 'vi')).toBe(answered);
  });

  it('no directive → untouched', () => {
    expect(ensureAskBack('Trả lời.', null, 'vi')).toBe('Trả lời.');
  });

  it('the appended ask REGISTERS as asked next turn (vi and en, role and deadline) — no nag loop', () => {
    for (const lang of ['vi', 'en']) {
      const askedRole = extractConversationState(
        [bot(ensureAskBack('Câu trả lời.', 'role', lang))],
        'nên sửa gì?',
      );
      expect(askedRole.asked_role).toBe(true);
      const askedDl = extractConversationState(
        [bot(ensureAskBack('Câu trả lời.', 'deadline', lang))],
        'nên sửa gì?',
      );
      expect(askedDl.asked_deadline).toBe(true);
    }
  });

  it('backstop copy carries no digits (it is persisted and replayed into history)', () => {
    for (const ask of ['role', 'deadline'] as const) {
      for (const lang of ['vi', 'en']) {
        expect(ensureAskBack('x.', ask, lang)).not.toMatch(/\d/);
      }
    }
  });
});

// ── Wave 3 (3B): deterministic deadline expiry ────────────────────────────────────────────────────

describe('deadlineSpanDays — honest span or null, never a guessed calendar date', () => {
  it.each([
    ['2 tuần', 14],
    ['3 ngày', 3],
    ['1 tháng', 30],
    ['2 weeks', 14],
    ['3 days', 3],
    ['1 month', 30],
    ['tuần sau', 7],
    ['ngày mai', 1],
    ['cuối tuần', 7],
    ['tháng sau', 30],
    ['cuối tháng', 30],
    ['1 tháng rưỡi', 45],
  ])('"%s" → %s days', (phrase, days) => {
    expect(deadlineSpanDays(phrase)).toBe(days);
  });

  it('returns null for a named month — no honest relative span exists', () => {
    expect(deadlineSpanDays('cuối tháng 8')).toBeNull();
    expect(deadlineSpanDays('đầu tháng 12')).toBeNull();
  });
});

describe('deadline_stated_at + deadlineStale', () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
  const NOW = new Date();

  it('records the timestamp of the HISTORY row that stated the deadline', () => {
    const at = daysAgo(20);
    const s = extractConversationState(
      [{ ...user('mình chỉ còn 2 tuần nữa thôi'), at }],
      'nên làm gì trước?',
    );
    expect(s.deadline).toBe('2 tuần nữa');
    expect(s.deadline_stated_at).toBe(at);
  });

  it('a deadline stated in the CURRENT question is fresh by definition (stated_at null, never stale)', () => {
    const s = extractConversationState([], 'mình chỉ còn 2 tuần nữa thôi');
    expect(s.deadline).toBe('2 tuần nữa');
    expect(s.deadline_stated_at).toBeNull();
    expect(deadlineStale(s, NOW)).toBe(false);
  });

  it('later-wins updates the timestamp along with the value', () => {
    const recentAt = daysAgo(1);
    const s = extractConversationState(
      [
        { ...user('mình còn 2 tuần'), at: daysAgo(30) },
        { ...user('giờ mình chỉ còn 3 ngày thôi'), at: recentAt },
      ],
      'ổn không?',
    );
    expect(s.deadline).toBe('3 ngày');
    expect(s.deadline_stated_at).toBe(recentAt);
    expect(deadlineStale(s, NOW)).toBe(false);
  });

  it('stale when the stated span has elapsed since the stating row', () => {
    const s = extractConversationState(
      [{ ...user('mình chỉ còn 2 tuần nữa thôi'), at: daysAgo(20) }],
      'nên làm gì trước?',
    );
    expect(deadlineStale(s, NOW)).toBe(true);
  });

  it('NOT stale while still inside the span, and never stale for an unparseable phrase', () => {
    const inside = extractConversationState(
      [{ ...user('mình chỉ còn 2 tuần nữa thôi'), at: daysAgo(3) }],
      'x?',
    );
    expect(deadlineStale(inside, NOW)).toBe(false);
    const named = extractConversationState(
      [{ ...user('hạn nộp trước cuối tháng 8'), at: daysAgo(300) }],
      'x?',
    );
    expect(named.deadline).toBe('cuối tháng 8');
    expect(deadlineStale(named, NOW)).toBe(false);
  });

  it('forget wipes the timestamp with the value (expiry can never resurrect a forgotten deadline)', () => {
    const s = extractConversationState(
      [{ ...user('mình còn 2 tuần'), at: daysAgo(20) }, user('quên thời hạn đi')],
      'x?',
    );
    expect(s.deadline).toBeNull();
    expect(s.deadline_stated_at).toBeNull();
    expect(deadlineStale(s, NOW)).toBe(false);
  });
});

describe('buildTurnContext — stale deadline changes the Known line, directives, and canned echo', () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
  const staleHistory = [
    { ...user('Mình đang nhắm vị trí Data Analyst và mình chỉ còn 2 tuần nữa.'), at: daysAgo(20) },
  ];

  it('marks the Known line as possibly past and directs a gentle re-ask, without inventing digits', () => {
    const ctx = buildTurnContext(FACTS, staleHistory, 'giờ mình nên làm gì trước?');
    expect(ctx.contextBlock).toContain('may ALREADY be past');
    expect(ctx.contextBlock).toContain('gently ask ONCE for their updated timeline');
    // replay safety: the ONLY digit tokens in the block are the user's own licensed "2" (from
    // "2 tuần") — the expiry copy itself must never add new ones ("20 days ago" would).
    const digits = ctx.contextBlock.match(/\d+/g) ?? [];
    expect(new Set(digits)).toEqual(new Set(['2']));
  });

  it('fresh deadline keeps the original Known line and weave directives', () => {
    const ctx = buildTurnContext(
      FACTS,
      [
        {
          ...user('Mình đang nhắm vị trí Data Analyst và mình chỉ còn 2 tuần nữa.'),
          at: daysAgo(1),
        },
      ],
      'giờ mình nên làm gì trước?',
    );
    expect(ctx.contextBlock).toContain('- Time budget/deadline: 2 tuần');
    expect(ctx.contextBlock).not.toContain('may ALREADY be past');
    expect(ctx.contextBlock).toContain('their deadline shapes HOW MUCH to attempt');
  });

  it('stale → the demonstrate-memory opener weaves the GOAL only, never the dead deadline', () => {
    const ctx = buildTurnContext(FACTS, staleHistory, 'giờ mình nên làm gì trước?');
    expect(ctx.contextBlock).toContain('weaving in their goal in one clause');
    expect(ctx.contextBlock).not.toContain('their deadline shapes HOW MUCH to attempt');
  });

  it('what_you_know canned echo flags the stale value honestly — no question mark, no new digits', () => {
    const ctx = buildTurnContext(FACTS, staleHistory, 'bạn nhớ gì về mình?');
    expect(ctx.intent).toBe('what_you_know');
    expect(ctx.canned).toContain('bạn từng nói quỹ thời gian là 2 tuần');
    expect(ctx.canned).toContain('chưa chắc còn đúng');
    expect(ctx.canned).not.toContain('?');
    expect((ctx.canned ?? '').match(/\d+/g) ?? []).toEqual(['2']);
  });

  it('an explicit now parameter drives staleness deterministically (harness hook)', () => {
    const statedAt = '2026-07-01T00:00:00.000Z';
    const history = [{ ...user('mình chỉ còn 3 ngày nữa thôi'), at: statedAt }];
    const fresh = buildTurnContext(
      FACTS,
      history,
      'x nên làm gì?',
      'vi',
      new Date('2026-07-02T00:00:00Z'),
    );
    const stale = buildTurnContext(
      FACTS,
      history,
      'x nên làm gì?',
      'vi',
      new Date('2026-07-10T00:00:00Z'),
    );
    expect(fresh.contextBlock).not.toContain('may ALREADY be past');
    expect(stale.contextBlock).toContain('may ALREADY be past');
  });
});

describe('coveredGapNames — role change archives old-role coverage (Wave 3)', () => {
  const gapFacts: DiagnosisFacts = {
    ...FACTS,
    gap_items: [
      { gap_id: 'g1', display_name: 'SQL' },
      { gap_id: 'g2', display_name: 'PyTorch' },
    ] as never,
  };

  it('only assistant turns AFTER the last role change count as coverage', () => {
    const history = [
      user('mình định nhắm Data Analyst'),
      bot('Ưu tiên SQL trước nhé.'),
      user('thôi mình chuyển sang nhắm Backend Developer rồi'),
      bot('Vậy giờ mở PyTorch trước nhé.'),
    ];
    // SQL WAS advised — but under the old role → archived; PyTorch named after the change → kept.
    expect(coveredGapNames(gapFacts, history)).toEqual(['PyTorch']);
  });

  it('restating the SAME role does not archive anything', () => {
    const history = [
      user('mình nhắm Data Analyst'),
      bot('Ưu tiên SQL trước nhé.'),
      user('như mình nói, mình nhắm Data Analyst đó'),
      bot('OK.'),
    ];
    expect(coveredGapNames(gapFacts, history)).toEqual(['SQL']);
  });

  it('the FIRST role statement never archives the pre-role advice', () => {
    const history = [bot('Ưu tiên SQL trước nhé.'), user('à, mình nhắm Data Analyst'), bot('OK.')];
    expect(coveredGapNames(gapFacts, history)).toEqual(['SQL']);
  });

  it('forget-then-restate of the SAME role keeps coverage (no phantom change)', () => {
    const history = [
      user('mình nhắm Data Analyst'),
      bot('Ưu tiên SQL trước nhé.'),
      user('quên vị trí đi'),
      user('mình nhắm Data Analyst nhé'),
      bot('OK.'),
    ];
    expect(coveredGapNames(gapFacts, history)).toEqual(['SQL']);
  });
});

describe('coveredGapNames — forget + different role still reads as a change', () => {
  const gapFacts: DiagnosisFacts = {
    ...FACTS,
    gap_items: [{ gap_id: 'g1', display_name: 'SQL' }] as never,
  };

  it('quên vị trí đi + a NEW role afterwards archives the old-role coverage', () => {
    const history = [
      user('mình nhắm Data Analyst'),
      bot('Ưu tiên SQL trước nhé.'),
      user('quên vị trí đi'),
      user('mình nhắm Backend Developer nhé'),
      bot('OK.'),
    ];
    expect(coveredGapNames(gapFacts, history)).toEqual([]);
  });
});

describe('factsForIntent — per-intent FACTS trim (Wave 3, 3C)', () => {
  it('drops other_matches on a non-comparison turn', () => {
    const trimmed = factsForIntent(FACTS_WITH_MATCHES, 'advice');
    expect(trimmed.other_matches).toBeUndefined();
    expect(trimmed.overall_score).toBe(FACTS_WITH_MATCHES.overall_score);
    // the original object is untouched — the service reuses input.facts for known_state
    expect(FACTS_WITH_MATCHES.other_matches).toHaveLength(1);
  });

  it('keeps other_matches on a compare_jd turn', () => {
    expect(factsForIntent(FACTS_WITH_MATCHES, 'compare_jd').other_matches).toHaveLength(1);
  });

  it('is a no-op when there are no other_matches', () => {
    expect(factsForIntent(FACTS, 'advice')).toBe(FACTS);
  });
});

describe('stale deadline → ask-back machinery re-fires ONCE (Wave 3, measured 0/4 directive-only)', () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
  const staleHistory = [
    { ...user('Mình đang nhắm vị trí Data Analyst và mình chỉ còn 2 tuần nữa.'), at: daysAgo(20) },
  ];

  it('an advice-seeking turn over a stale deadline sets ask=deadline (ensureAskBack will append)', () => {
    const ctx = buildTurnContext(FACTS, staleHistory, 'giờ mình nên làm gì tiếp theo đây?');
    expect(ctx.ask).toBe('deadline');
    // the generic "they have NOT told you" line must NOT ride along — the expiry directive owns
    // the re-ask on stale turns (the generic line would contradict the Known line's old value).
    expect(ctx.contextBlock).not.toContain('They have NOT told you how much time');
    expect(ensureAskBack('Cứ sửa bullet trước.', ctx.ask, 'vi')).toContain('?');
  });

  it('one-shot: after the backstop ask registers in history, a stale turn does not nag again', () => {
    const history = [
      ...staleHistory,
      {
        ...bot('Cứ sửa bullet trước. Mà bạn còn bao nhiêu thời gian trước hạn nộp vậy?'),
      },
      user('chưa rõ nữa'),
    ];
    const ctx = buildTurnContext(FACTS, history, 'vậy mình nên ưu tiên gì?');
    expect(ctx.state.asked_deadline).toBe(true);
    expect(ctx.ask).toBeNull();
  });

  it('a FRESH deadline never trips the stale re-ask', () => {
    const ctx = buildTurnContext(
      FACTS,
      [{ ...user('Mình nhắm vị trí Data Analyst, còn 2 tuần nữa.'), at: daysAgo(1) }],
      'giờ mình nên làm gì tiếp theo đây?',
    );
    expect(ctx.ask).toBeNull();
  });
});

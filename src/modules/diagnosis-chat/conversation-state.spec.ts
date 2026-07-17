import {
  askDirective,
  ensureAskBack,
  buildTurnContext,
  coveredGapNames,
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

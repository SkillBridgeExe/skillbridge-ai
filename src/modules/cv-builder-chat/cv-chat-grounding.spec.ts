import { groundCvChat } from './cv-chat-grounding';
import { buildDiagnosisChatBlock } from './cv-builder-diagnosis';

const facts: any = {
  cv_language: 'vi',
  focus: {
    section: 'projects',
    field_path: 'projects[0].description',
    current_text: 'Làm web bán hàng',
    gaps: ['result'],
  },
  target_role: 'Data Analyst',
  sections: [],
};

// ---- the 5 invariants (from the brief — these define "done") ------------------

it('strips a fabricated metric from a proposed edit → refusal, not a silent invented number', () => {
  const parsed = {
    message: 'Mình viết lại rồi nhé.',
    used_facts: [],
    proposed_edit: {
      field_path: 'projects[0].description',
      after: 'Built e-commerce web, cut load time 40%',
    },
    cited_field_path: null,
    suggested_next_step: null,
  };
  const r = groundCvChat(parsed, facts, 'vi', 'làm web bán hàng'); // user NEVER said 40%
  expect(r.answer_kind).toBe('refusal');
  expect(r.proposed_edit).toBeNull();
  expect(r.answer).not.toContain('40%');
});

it('keeps a proposed edit whose numbers/tech all trace to the user', () => {
  const parsed = {
    message: 'Đây nhé.',
    used_facts: ['react', '40%'],
    proposed_edit: {
      field_path: 'projects[0].description',
      after: 'Built e-commerce web with React, cut page load time 40%',
    },
    cited_field_path: 'projects[0].description',
    suggested_next_step: null,
  };
  const r = groundCvChat(parsed, facts, 'vi', 'mình dùng react, giảm load 40%');
  expect(r.answer_kind).toBe('grounded');
  expect(r.proposed_edit?.after).toContain('40%');
});

it('lets general craft advice through untouched (not a factual claim about the user)', () => {
  const parsed = {
    message: 'Bullet mạnh nên bắt đầu bằng động từ hành động và kết thúc bằng một kết quả đo được.',
    used_facts: [],
    proposed_edit: null,
    cited_field_path: null,
    suggested_next_step: null,
  };
  const r = groundCvChat(parsed, facts, 'vi', 'viết bullet sao cho mạnh?');
  expect(r.answer_kind).toBe('grounded');
  expect(r.answer).toContain('động từ hành động');
});

it('never licenses a number the model itself introduced last turn (only candidateSaid = USER words)', () => {
  const parsed = {
    message: 'Như mình nói, tăng 55%.',
    used_facts: [],
    proposed_edit: null,
    cited_field_path: null,
    suggested_next_step: null,
  };
  const r = groundCvChat(parsed, facts, 'vi', 'ok tiếp đi'); // 55% appears nowhere in user words
  expect(r.answer).not.toContain('55%');
});

it('parsed=null → deterministic honest fallback, not a throw', () => {
  const r = groundCvChat(null, facts, 'vi', 'x');
  expect(r.answer_kind).toBe('canned');
  expect(r.proposed_edit).toBeNull();
});

// ---- NFKC / fail-closed: a fullwidth-digit fabrication must not slip ----------

it('catches a FULLWIDTH-digit fabrication in a proposed edit → refusal (NFKC/fail-closed)', () => {
  const parsed = {
    message: 'Đây nhé.',
    used_facts: [],
    proposed_edit: {
      field_path: 'projects[0].description',
      after: 'Built e-commerce web, cut load time ４０％', // fullwidth 40%
    },
    cited_field_path: null,
    suggested_next_step: null,
  };
  const r = groundCvChat(parsed, facts, 'vi', 'làm web bán hàng'); // no 40 anywhere
  expect(r.answer_kind).toBe('refusal');
  expect(r.proposed_edit).toBeNull();
  expect(r.answer).not.toContain('40%');
  expect(r.answer).not.toContain('４０％');
});

// ---- gate hardening: prose tech, Arabic-Indic digits, suggested_next_step chip -------

it('refuses a PROSE message that names a tech the user never licensed (NAMED_TECH net)', () => {
  const parsed = {
    message: 'Ngon, mình đã thêm Kubernetes vào phần kỹ năng cho bạn.',
    used_facts: [],
    proposed_edit: null,
    cited_field_path: null,
    suggested_next_step: null,
  };
  const r = groundCvChat(parsed, facts, 'vi', 'giúp mình mạnh phần kỹ năng'); // never said Kubernetes
  expect(r.answer_kind).toBe('refusal');
  expect(r.answer).not.toContain('Kubernetes');
});

it('catches an ARABIC-INDIC digit fabrication in a proposed edit → refusal (\\p{Nd} fail-closed)', () => {
  const parsed = {
    message: 'Đây nhé.',
    used_facts: [],
    proposed_edit: {
      field_path: 'projects[0].description',
      after: 'Built e-commerce web, cut load time ٤٠%', // Arabic-Indic 40%
    },
    cited_field_path: null,
    suggested_next_step: null,
  };
  const r = groundCvChat(parsed, facts, 'vi', 'làm web bán hàng'); // no 40 anywhere
  expect(r.answer_kind).toBe('refusal');
  expect(r.proposed_edit).toBeNull();
});

it('gates suggested_next_step through the fabrication net → grounded prose, but the chip is nulled', () => {
  const parsed = {
    message: 'Ừ, tiếp thôi nhé.',
    used_facts: [],
    proposed_edit: null,
    cited_field_path: null,
    suggested_next_step: 'Thêm chứng chỉ AWS và mức tăng 40% vào CV nhé', // AWS + 40% never licensed
  };
  const r = groundCvChat(parsed, facts, 'vi', 'ok tiếp đi');
  expect(r.answer_kind).toBe('grounded');
  expect(r.suggested_next_step).toBeNull();
});

it('gates a fabricated suggested_next_step on the PROPOSED-EDIT path too (grounded edit stays, chip is nulled)', () => {
  const parsed = {
    message: 'Đây nhé.',
    used_facts: ['react', '40%'],
    proposed_edit: {
      field_path: 'projects[0].description',
      after: 'Built e-commerce web with React, cut page load time 40%',
    },
    cited_field_path: 'projects[0].description',
    suggested_next_step: 'Thêm chứng chỉ AWS và mức tăng 55% nữa nhé', // AWS + chứng chỉ + 55% never licensed
  };
  const r = groundCvChat(parsed, facts, 'vi', 'mình dùng react, giảm load 40%');
  expect(r.answer_kind).toBe('grounded');
  expect(r.proposed_edit).not.toBeNull();
  expect(r.suggested_next_step).toBeNull();
});

// ---- Slice-4 tuning: buy back benign advice quantities (must NOT be refusal) ----------
// A small unitless count/range over a CV-writing advice noun is a count of what to WRITE, not a
// claim about the user's record. These good advice turns were being downgraded to a canned refusal.

const roleFacts = { ...facts, target_role: 'Full-stack Developer' };

const proseOnly = (message: string, next: string | null = null) => ({
  message,
  used_facts: [],
  proposed_edit: null,
  cited_field_path: null,
  suggested_next_step: next,
});

it('buys back "1 công nghệ" — a benign writing-craft count, not a fabricated metric', () => {
  const r = groundCvChat(
    proseOnly('Bạn cho mình biết 1 công nghệ chính bạn dùng nhé'),
    facts,
    'vi',
    '', // user has said nothing yet
  );
  expect(r.answer_kind).not.toBe('refusal');
  expect(r.answer).toContain('công nghệ'); // the advice survives, not a canned refusal
});

it('buys back a "2-3 phiên bản" range over an advice noun', () => {
  const r = groundCvChat(
    proseOnly('Để mình viết thêm 2-3 phiên bản cho bạn chọn nhé'),
    facts,
    'vi',
    '',
  );
  expect(r.answer_kind).not.toBe('refusal');
  expect(r.answer).toContain('phiên bản');
});

it('buys back "yếu ở 3 chỗ" — a count of writing spots, not a score', () => {
  const r = groundCvChat(
    proseOnly('Đoạn này đang yếu ở 3 chỗ, mình sửa giúp bạn nhé'),
    facts,
    'vi',
    '',
  );
  expect(r.answer_kind).not.toBe('refusal');
  expect(r.answer).toContain('3 chỗ');
});

it("licenses the user's OWN target_role in prose (not a fabricated entity)", () => {
  const r = groundCvChat(
    proseOnly('Mình sẽ chỉnh để mạnh hơn cho vị trí Full-stack Developer nhé'),
    roleFacts,
    'vi',
    '',
  );
  expect(r.answer_kind).not.toBe('refusal');
  expect(r.answer).toContain('Full-stack Developer');
});

// ---- Slice-4 tuning: the buy-back must NOT reopen a real fabrication (STAY refusal) ----------

it('still refuses a UNIT-BEARING number the user never gave ("40% thời gian")', () => {
  const r = groundCvChat(
    proseOnly('Như bạn nói, bạn đã giảm 40% thời gian xử lý'),
    facts,
    'vi',
    'ok tiếp đi', // user never said 40%
  );
  expect(r.answer_kind).toBe('refusal');
  expect(r.answer).not.toContain('40%');
});

it('still refuses an ungrounded tech in prose that is NOT the target_role ("Firebase")', () => {
  const r = groundCvChat(
    proseOnly('Bạn nên dùng Firebase Auth cho phần đăng nhập nhé'),
    facts,
    'vi',
    'giúp mình phần đăng nhập', // never said Firebase; target_role = Data Analyst
  );
  expect(r.answer_kind).toBe('refusal');
  expect(r.answer).not.toContain('Firebase');
});

it('still refuses a DIFFERENT invented title (≠ the licensed target_role)', () => {
  const r = groundCvChat(
    proseOnly('Mình ghi bạn là Trưởng Nhóm Kỹ Thuật cho oai nhé'),
    roleFacts, // target_role = Full-stack Developer, NOT this title
    'vi',
    '',
  );
  expect(r.answer_kind).toBe('refusal');
  expect(r.answer).not.toContain('Trưởng Nhóm Kỹ Thuật');
});

it('still refuses a FULLWIDTH-digit metric in prose ("giảm ４０%") — fail-closed intact', () => {
  const r = groundCvChat(
    proseOnly('Như bạn nói, bạn đã giảm ４０% thời gian'),
    facts,
    'vi',
    'ok tiếp đi',
  );
  expect(r.answer_kind).toBe('refusal');
  expect(r.answer).not.toContain('40%');
  expect(r.answer).not.toContain('４０％');
});

// ---- two-tier benign rule: CLOSED HOLES — a worded unit / score / record-count must NOT slip in on
// an "advice noun". `phần` is only benign as "part", never as "phần trăm"; `điểm` is never benign;
// an ASK noun (count the user is asked to PROVIDE / a count of their record) is benign ONLY at 1.

it('refuses a WORDED-PERCENT metric ("giảm 5 phần trăm") — phần trăm is a unit, not a "part"', () => {
  const r = groundCvChat(proseOnly('Bạn đã giảm 5 phần trăm thời gian xử lý'), facts, 'vi', '');
  expect(r.answer_kind).toBe('refusal');
  expect(r.proposed_edit).toBeNull();
});

it('refuses a WORDED-PERCENT range ("giảm 2-3 phần trăm")', () => {
  const r = groundCvChat(proseOnly('Bạn giảm được 2-3 phần trăm nhé'), facts, 'vi', '');
  expect(r.answer_kind).toBe('refusal');
});

it('refuses a fabricated SCORE ("đạt 5 điểm") — điểm is excluded from the benign list', () => {
  const r = groundCvChat(proseOnly('CV của bạn đạt 5 điểm rồi nhé'), facts, 'vi', '');
  expect(r.answer_kind).toBe('refusal');
  expect(r.proposed_edit).toBeNull();
});

it('refuses a fabricated proficiency SCORE ("React ở mức 4 điểm")', () => {
  const r = groundCvChat(proseOnly('Kỹ năng React của bạn ở mức 4 điểm'), facts, 'vi', '');
  expect(r.answer_kind).toBe('refusal');
});

it('refuses a fabricated COUNT of the record ("đã làm 3 việc") — ASK noun benign only at 1', () => {
  const r = groundCvChat(proseOnly('Như bạn nói, bạn đã làm 3 việc quan trọng'), facts, 'vi', '');
  expect(r.answer_kind).toBe('refusal');
});

it('refuses a fabricated COUNT of the record ("có 5 công nghệ mạnh") — ASK noun benign only at 1', () => {
  const r = groundCvChat(proseOnly('Nhìn CV thì bạn có 5 công nghệ mạnh'), facts, 'vi', '');
  expect(r.answer_kind).toBe('refusal');
});

// ---- discriminating regression: the CLOSED-HOLES tests above pass "for the wrong reason" — their
// values exceed the TIER-1 cap (≤3) so they'd refuse even if a guard were removed. These three sit
// AT the boundary (n==1 / n<=3) where removing the actual guard WOULD flip the outcome to grounded.

it('refuses "giảm 1 phần trăm thời gian xử lý" — locks the phần(?!\\s*trăm) lookahead, not just the cap', () => {
  const r = groundCvChat(proseOnly('giảm 1 phần trăm thời gian xử lý'), facts, 'vi', '');
  expect(r.answer_kind).toBe('refusal');
  expect(r.answer).not.toContain('1 phần trăm');
  expect(r.answer).not.toContain('phần trăm');
});

it('refuses "CV của bạn đạt 3 điểm" — locks điểm excluded from WRITING_NOUN at the ≤3 cap', () => {
  const r = groundCvChat(proseOnly('CV của bạn đạt 3 điểm'), facts, 'vi', '');
  expect(r.answer_kind).toBe('refusal');
  expect(r.proposed_edit).toBeNull();
});

it('refuses "kỹ năng của bạn ở mức 1 điểm" — locks điểm excluded from ASK_NOUN at n==1', () => {
  const r = groundCvChat(proseOnly('kỹ năng của bạn ở mức 1 điểm'), facts, 'vi', '');
  expect(r.answer_kind).toBe('refusal');
});

// ---- two-tier benign rule: KEPT BUY-BACKS — the legitimate writing-craft / ask-one quantities that
// drive quality must STILL ship (they describe the advice/text, or ask the user for ONE thing).

it('keeps "1 công nghệ" — ASK noun at exactly 1 (asking the user for one thing)', () => {
  const r = groundCvChat(proseOnly('Bạn cho mình biết 1 công nghệ chính nhé'), facts, 'vi', '');
  expect(r.answer_kind).toBe('grounded');
  expect(r.answer).toContain('công nghệ');
});

it('keeps "2-3 phiên bản" — WRITING noun, range max ≤ 3 (a count of the text)', () => {
  const r = groundCvChat(
    proseOnly('Để mình viết thêm 2-3 phiên bản cho bạn chọn nhé'),
    facts,
    'vi',
    '',
  );
  expect(r.answer_kind).toBe('grounded');
  expect(r.answer).toContain('phiên bản');
});

it('keeps "3 chỗ" — WRITING noun at 3 (a count of writing spots, not a score)', () => {
  const r = groundCvChat(
    proseOnly('Đoạn này đang yếu ở 3 chỗ, mình sửa giúp bạn nhé'),
    facts,
    'vi',
    '',
  );
  expect(r.answer_kind).toBe('grounded');
  expect(r.answer).toContain('3 chỗ');
});

it('keeps "1 chi tiết" — ASK noun at exactly 1', () => {
  const r = groundCvChat(
    proseOnly('Bạn kể mình thêm 1 chi tiết cụ thể bạn đã làm nhé'),
    facts,
    'vi',
    '',
  );
  expect(r.answer_kind).toBe('grounded');
  expect(r.answer).toContain('chi tiết');
});

// ---- Task B3: TWO-CORPUS gate — the diagnosis block licenses PROSE (the message) only. It must
// NEVER widen the edit corpus (a tool the scan says the user is MISSING can't be inserted into the CV)
// nor the suggestion chip, and its number-wall (digit-strip in the block) must stay intact. -----------

describe('groundCvChat — diagnosis prose license (two-corpus)', () => {
  const withDiagnosis = (diagnosis: unknown) => ({ ...facts, diagnosis });

  // A scan tip that names a tech the user is MISSING. Digit-free by construction.
  const dockerBlock = {
    prioritized_actions: [],
    dimension_notes: [],
    bullet_notes: [
      { excerpt: 'Làm web bán hàng', tips: ['Thêm bằng chứng Docker vào phần kỹ năng'] },
    ],
  };

  it('1) the message may DISCUSS a tech the scan flagged (Docker in the block) → grounded', () => {
    const r = groundCvChat(
      {
        message: 'Bạn nên bổ sung bằng chứng Docker để phần kỹ năng mạnh hơn nhé.',
        used_facts: [],
        proposed_edit: null,
        cited_field_path: null,
        suggested_next_step: null,
      },
      withDiagnosis(dockerBlock),
      'vi',
      'giúp mình phần kỹ năng', // user NEVER typed Docker
    );
    expect(r.answer_kind).toBe('grounded');
    expect(r.answer).toContain('Docker');
  });

  it('2) the SAME Docker can NEVER enter a proposed edit (edit corpus excludes diagnosis) → refusal', () => {
    const r = groundCvChat(
      {
        message: 'Đây nhé.',
        used_facts: [],
        proposed_edit: {
          field_path: 'projects[0].description',
          after: 'Xây dựng web bán hàng với Docker',
        },
        cited_field_path: null,
        suggested_next_step: null,
      },
      withDiagnosis(dockerBlock),
      'vi',
      'giúp mình phần kỹ năng', // user NEVER typed Docker
    );
    expect(r.answer_kind).toBe('refusal');
    expect(r.proposed_edit).toBeNull();
  });

  it('3) a scan number is digit-stripped from the block → the message cannot re-launder it → refusal', () => {
    const block = buildDiagnosisChatBlock({
      rationale: {
        action_verbs: '',
        skills_relevance: '',
        experience: 'thiếu kết quả đo được như giảm 40% thời gian',
        education: '',
      },
      top_summary: { headline: 'x', prioritized_actions: [] },
      bullet_feedback: [],
    } as never);
    expect(JSON.stringify(block)).not.toMatch(/40|\d/); // number-wall: the block is digit-free

    const r = groundCvChat(
      {
        message: 'Như chẩn đoán nói, bạn đã giảm 40% thời gian xử lý.',
        used_facts: [],
        proposed_edit: null,
        cited_field_path: null,
        suggested_next_step: null,
      },
      withDiagnosis(block),
      'vi',
      'ok tiếp đi', // user never said 40%
    );
    expect(r.answer_kind).toBe('refusal');
    expect(r.answer).not.toContain('40%');
  });

  it('4) the suggestion chip stays gated by licensed-only (Docker chip nulled) though prose is grounded', () => {
    const r = groundCvChat(
      {
        message: 'Bạn xem lại phần kỹ năng nhé.',
        used_facts: [],
        proposed_edit: null,
        cited_field_path: null,
        suggested_next_step: 'Thêm Docker vào CV nhé',
      },
      withDiagnosis(dockerBlock),
      'vi',
      'giúp mình phần kỹ năng',
    );
    expect(r.answer_kind).toBe('grounded');
    expect(r.suggested_next_step).toBeNull();
  });

  it('5) with NO diagnosis block the very same Docker message refuses — proves the license is what flips it', () => {
    const r = groundCvChat(
      {
        message: 'Bạn nên bổ sung bằng chứng Docker để phần kỹ năng mạnh hơn nhé.',
        used_facts: [],
        proposed_edit: null,
        cited_field_path: null,
        suggested_next_step: null,
      },
      { ...facts, diagnosis: null },
      'vi',
      'giúp mình phần kỹ năng',
    );
    expect(r.answer_kind).toBe('refusal');
    expect(r.answer).not.toContain('Docker');
  });
});

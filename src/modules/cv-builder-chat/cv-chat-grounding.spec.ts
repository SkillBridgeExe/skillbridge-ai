import { groundCvChat } from './cv-chat-grounding';

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

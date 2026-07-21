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

// ---- measured gate-overkill FP families (field-filling probe 2026-07-20): cooperative coaching
// turns were killed by TOKENIZER artifacts, not by real fabrication. Each family locks the buy-back
// AND a same-shape stay-refusal, so the fix cannot silently widen the number/entity wall.

// family 1 — en-dash range: "1–2" must be ONE range token folding to "1-2", not a killed bare "1".
it('keeps "1–2 câu" — an en-dash advice range folds to the ASCII range form', () => {
  const r = groundCvChat(proseOnly('Phần này nên gói trong 1–2 câu là đủ nhé'), facts, 'vi', '');
  expect(r.answer_kind).toBe('grounded');
  expect(r.answer).toContain('1–2 câu');
});

it('still refuses an en-dash range over a non-advice noun ("1–2 triệu")', () => {
  const r = groundCvChat(proseOnly('Mức đó tầm 1–2 triệu mỗi tháng'), facts, 'vi', '');
  expect(r.answer_kind).toBe('refusal');
});

it('keeps a proposed edit whose en-dash range the user gave in ASCII ("2022–2023")', () => {
  const parsed = {
    message: 'Đây nhé.',
    used_facts: [],
    proposed_edit: {
      field_path: 'projects[0].description',
      after: 'Làm web bán hàng, thực tập 2022–2023',
    },
    cited_field_path: null,
    suggested_next_step: null,
  };
  const r = groundCvChat(parsed, facts, 'vi', 'mình thực tập 2022-2023');
  expect(r.answer_kind).toBe('grounded');
  expect(r.proposed_edit?.after).toContain('2022–2023');
});

// family 2 — a letter unit must not eat the first letter of the next word: "1 kết quả" tokenized as
// "1 k" (thousand) and "3 mảnh" as "3 m" (metres), so the benign noun was never adjacent.
it('keeps "1 kết quả" — the unit "k" no longer swallows "kết quả"', () => {
  const r = groundCvChat(
    proseOnly('Bạn cho mình xin 1 kết quả đo được của dự án nhé'),
    facts,
    'vi',
    '',
  );
  expect(r.answer_kind).toBe('grounded');
  expect(r.answer).toContain('1 kết quả');
});

it('still refuses "4 kết quả" — ASK noun stays benign only at exactly 1', () => {
  const r = groundCvChat(proseOnly('Bạn kể mình 4 kết quả nổi bật nhé'), facts, 'vi', '');
  expect(r.answer_kind).toBe('refusal');
});

it('still refuses a REAL k-unit metric ("tăng 5k mỗi tháng") — the unit net is intact', () => {
  const r = groundCvChat(proseOnly('Bạn ghi doanh thu tăng 5k mỗi tháng nhé'), facts, 'vi', '');
  expect(r.answer_kind).toBe('refusal');
});

// family 3 — measured noun-list gaps: thứ / mảnh / con số / điểm mạnh.
// `thứ` was measured as an FP but is NOT bought back: it is a bare classifier that joins record
// nouns ("2 thứ tiếng" = two languages, "2 thứ hạng cao" = rankings) with no safe discriminator —
// adversarial-review finding. The over-refusal is accepted as a residual (safe direction).
it('refuses "2 thứ hạng cao" — bare `thứ` stays OUT of the benign lists (classifier hole)', () => {
  const r = groundCvChat(
    proseOnly('Bạn đã có 2 thứ hạng cao trong các cuộc thi lập trình'),
    facts,
    'vi',
    '',
  );
  expect(r.answer_kind).toBe('refusal');
});

it('refuses "3 mảnh kinh nghiệm" — `mảnh` is benign ONLY in the full phrase "mảnh thông tin"', () => {
  const r = groundCvChat(
    proseOnly('Nhìn CV thì bạn có 3 mảnh kinh nghiệm quốc tế nổi bật'),
    facts,
    'vi',
    '',
  );
  expect(r.answer_kind).toBe('refusal');
});

it('refuses "3 phần kinh nghiệm" — `phần` is benign only phrase-final ("cần 2 phần:")', () => {
  const r = groundCvChat(
    proseOnly('CV của bạn có 3 phần kinh nghiệm ấn tượng đấy'),
    facts,
    'vi',
    '',
  );
  expect(r.answer_kind).toBe('refusal');
});

it('keeps "3 mảnh thông tin" — pieces of info to collect, not a metric', () => {
  const r = groundCvChat(
    proseOnly('Cho mình 3 mảnh thông tin nhé: bạn làm gì, dùng công nghệ nào, kết quả ra sao'),
    facts,
    'vi',
    '',
  );
  expect(r.answer_kind).toBe('grounded');
});

it('keeps "1 con số" — asking the user for exactly one number', () => {
  const r = groundCvChat(
    proseOnly('Bạn cho mình đúng 1 con số cụ thể về kết quả nhé'),
    facts,
    'vi',
    '',
  );
  expect(r.answer_kind).toBe('grounded');
});

it('keeps "2-3 điểm mạnh" — a summary-writing count; bare "điểm" stays walled', () => {
  const r = groundCvChat(
    proseOnly('Phần tóm tắt nên nêu 2-3 điểm mạnh gắn với vị trí bạn nhắm nhé'),
    facts,
    'vi',
    '',
  );
  expect(r.answer_kind).toBe('grounded');
});

it('still refuses "5 điểm mạnh" — the ≤3 writing cap holds for the new noun too', () => {
  const r = groundCvChat(proseOnly('Nhìn CV thì bạn có 5 điểm mạnh rõ ràng'), facts, 'vi', '');
  expect(r.answer_kind).toBe('refusal');
});

it('keeps "cần 2 phần" — a bullet-structure count (live-run kill 2026-07-20)', () => {
  const r = groundCvChat(
    proseOnly('Câu nghe xịn hơn thường cần 2 phần: bạn đã làm gì và nó tạo ra tác động gì'),
    facts,
    'vi',
    '',
  );
  expect(r.answer_kind).toBe('grounded');
});

it('still refuses "tăng 2 phần trăm" — the trăm lookahead rides along into WRITING_NOUN', () => {
  const r = groundCvChat(proseOnly('Bạn ghi là tăng 2 phần trăm nhé'), facts, 'vi', '');
  expect(r.answer_kind).toBe('refusal');
});

// family 6 — enumeration markers: "1) … 2) …" opening the lines of an advice list.
it('keeps a numbered list of two rewrite options ("1) … 2) …")', () => {
  const r = groundCvChat(
    proseOnly(
      'Mình gợi ý 2 bản ngắn hơn:\n1) Xây dựng API đăng nhập cho nhóm dự án cuối kỳ.\n2) Phát triển API đăng nhập cho nhóm dự án cuối kỳ.',
    ),
    facts,
    'vi',
    'mình xây dựng API đăng nhập cho nhóm dự án cuối kỳ',
  );
  expect(r.answer_kind).toBe('grounded');
});

it('still refuses an "(x2)" multiplier — a digit before ")" mid-line is not a list marker', () => {
  const r = groundCvChat(proseOnly('Hiệu năng tăng (x2) sau đợt tối ưu'), facts, 'vi', '');
  expect(r.answer_kind).toBe('refusal');
});

it('still refuses a metric INSIDE a numbered list item — the marker shields only the ordinal', () => {
  const r = groundCvChat(
    proseOnly('Bạn có thể trình bày:\n1) Xây dựng API đăng nhập.\n2) Đạt 90% uptime.'),
    facts,
    'vi',
    'mình xây dựng API đăng nhập',
  );
  expect(r.answer_kind).toBe('refusal');
});

it('keeps a DOT-numbered list ("1. … 2. …") — the other marker style from the live runs', () => {
  const r = groundCvChat(
    proseOnly(
      'Mình viết 2 bản để bạn chọn:\n1. Xây dựng website bán hàng cùng nhóm.\n2. Cùng nhóm xây dựng website bán hàng.',
    ),
    facts,
    'vi',
    'mình cùng nhóm xây dựng website bán hàng',
  );
  expect(r.answer_kind).toBe('grounded');
});

it('still refuses a sentence-final digit mid-line ("đạt 2.") — not a list marker', () => {
  const r = groundCvChat(proseOnly('Kỹ năng này bạn đạt 2. Cần cải thiện thêm'), facts, 'vi', '');
  expect(r.answer_kind).toBe('refusal');
});

it('keeps "2 điểm chính" — main points of the critique, never a score phrase', () => {
  const r = groundCvChat(
    proseOnly('Bản quét đang chê đúng 2 điểm chính ở bullet này: mở đầu yếu và thiếu kết quả'),
    facts,
    'vi',
    '',
  );
  expect(r.answer_kind).toBe('grounded');
});

it('still refuses bare "2 điểm" — the score wall does not ride on the new phrase', () => {
  const r = groundCvChat(proseOnly('CV của bạn được 2 điểm thôi nhé'), facts, 'vi', '');
  expect(r.answer_kind).toBe('refusal');
});

// family 4 — a comma list must not be joined into a phrase nobody wrote ("React, Firebase" was
// minted as the entity "React Firebase", unlicensed even though EACH tech was licensed).
it('keeps "React, Firebase" — a comma list of two LICENSED techs is not one fabricated entity', () => {
  const r = groundCvChat(
    proseOnly('Bạn nên nêu rõ React, Firebase ngay câu đầu phần dự án nhé'),
    facts,
    'vi',
    'mình dùng React và Firebase cho đồ án',
  );
  expect(r.answer_kind).toBe('grounded');
});

it('still refuses an UNLICENSED tech after a comma ("…, Kafka") — NAMED_TECH is per-token', () => {
  const r = groundCvChat(
    proseOnly('Bạn nên thêm Redis, Kafka vào phần kỹ năng'),
    facts,
    'vi',
    'mình dùng Redis',
  );
  expect(r.answer_kind).toBe('refusal');
});

it('still refuses a fabricated TitleCase org pair inside one sentence ("Nova Dynamics")', () => {
  const r = groundCvChat(
    proseOnly('Bạn nên ghi kinh nghiệm ở Nova Dynamics vào nhé'),
    facts,
    'vi',
    '',
  );
  expect(r.answer_kind).toBe('refusal');
});

it('keeps a proposed edit listing licensed techs with commas', () => {
  const parsed = {
    message: 'Đây nhé.',
    used_facts: [],
    proposed_edit: {
      field_path: 'projects[0].description',
      after: 'Xây dựng web bán hàng với React, Firebase',
    },
    cited_field_path: null,
    suggested_next_step: null,
  };
  const r = groundCvChat(parsed, facts, 'vi', 'mình dùng React và Firebase');
  expect(r.answer_kind).toBe('grounded');
  expect(r.proposed_edit?.after).toContain('React, Firebase');
});

// family 5 — a name run must not be joined ACROSS a sentence boundary ("Docker. Bản" / "Backend
// Developer. Với" were minted as phrases and killed licensed prose).
it('keeps the licensed target_role at a sentence end ("… Backend Developer. Với …")', () => {
  const bdFacts = { ...facts, target_role: 'Backend Developer' };
  const r = groundCvChat(
    proseOnly(
      'Hồ sơ đang nhắm Backend Developer. Với mục tiêu đó, phần dự án nên nêu kết quả rõ hơn nhé',
    ),
    bdFacts,
    'vi',
    '',
  );
  expect(r.answer_kind).toBe('grounded');
});

it('keeps a licensed tech at a sentence end ("… dùng Docker. Bản mô tả …")', () => {
  const r = groundCvChat(
    proseOnly('Bạn có kể đã dùng Docker. Bản mô tả nên nói rõ bạn dùng nó vào việc gì nhé'),
    facts,
    'vi',
    'mình có dùng docker để deploy đồ án',
  );
  expect(r.answer_kind).toBe('grounded');
});

it('still refuses an UNLICENSED tech even at a sentence end ("… dùng Docker. Bạn …")', () => {
  const r = groundCvChat(
    proseOnly('Mình khuyên bạn dùng Docker. Bạn thêm vào phần kỹ năng nhé'),
    facts,
    'vi',
    '',
  );
  expect(r.answer_kind).toBe('refusal');
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

// ---- 2026-07-21 residual buy-backs (kiểu / cách viết / "CV <licensed role>") -----------------
// Same discipline as every widening: each buy-back locks BOTH the keep and a same-shape
// stay-refusal, so the noun list cannot silently widen the number/entity wall.

it('keeps "3 kiểu:" — an enumerated advice-kind count, phrase-final only', () => {
  const r = groundCvChat(
    proseOnly('Mở đầu bullet có 3 kiểu: nêu kết quả, nêu vai trò, nêu công nghệ.'),
    facts,
    'vi',
    '',
  );
  expect(r.answer_kind).not.toBe('refusal');
  expect(r.answer).toContain('3 kiểu');
});

it('still refuses "3 kiểu dự án" — kiểu followed by a letter-word is a record claim', () => {
  const r = groundCvChat(proseOnly('Bạn từng làm 3 kiểu dự án khác nhau rồi mà.'), facts, 'vi', '');
  expect(r.answer_kind).toBe('refusal');
});

it('keeps "2 cách viết" — a count of writing options (full phrase only)', () => {
  const r = groundCvChat(
    proseOnly('Mình gợi ý 2 cách viết cho đoạn này để bạn chọn nhé.'),
    facts,
    'vi',
    '',
  );
  expect(r.answer_kind).not.toBe('refusal');
  expect(r.answer).toContain('2 cách viết');
});

it('still refuses "5 cách viết" — the writing-noun cap (≤3) is intact', () => {
  const r = groundCvChat(proseOnly('Mình có 5 cách viết hay lắm.'), facts, 'vi', ''); // >3 → wall
  expect(r.answer_kind).toBe('refusal');
});

it('still refuses bare "3 cách" — only the full phrase `cách viết` is listed', () => {
  const r = groundCvChat(proseOnly('Bạn đã xử lý theo 3 cách sáng tạo.'), facts, 'vi', '');
  expect(r.answer_kind).toBe('refusal');
});

it('keeps "CV Business Analyst" when the role itself is licensed (leading-CV relief)', () => {
  const baFacts = { ...facts, target_role: 'Business Analyst' };
  const r = groundCvChat(
    proseOnly('Để CV Business Analyst của bạn nổi bật, bullet nên mở đầu bằng động từ.'),
    baFacts,
    'vi',
    '',
  );
  expect(r.answer_kind).not.toBe('refusal');
  expect(r.answer).toContain('CV Business Analyst');
});

it('still refuses "CV Nova Dynamics" — the remainder after "CV " is an unlicensed org', () => {
  const r = groundCvChat(
    proseOnly('Mình tham khảo mẫu CV Nova Dynamics cho bạn nhé.'),
    facts,
    'vi',
    '',
  );
  expect(r.answer_kind).toBe('refusal');
  expect(r.answer).not.toContain('Nova');
});

// ---- 2026-07-21 warm refusal copy (variants, digit-free, gap-contextual) ---------------------
// The single canned template was the measured top "robot" complaint on refusal turns. The copy now
// rotates deterministically on the model's blocked message; every variant must stay DIGIT-FREE
// (a refusal must not itself leak a number) and must name the first detected gap.

it('prose-refusal copy: digit-free, names the gap hint, and actually varies', () => {
  const seen = new Set<string>();
  const fabricating = [
    'Bạn đã tăng 47% hiệu suất rồi đó.',
    'Web của bạn nhanh hơn 62% luôn.',
    'Doanh thu tăng 91% nhờ bạn.',
    'Bạn giảm 33% thời gian xử lý.',
    'Đội của bạn tiết kiệm 78% chi phí.',
    'Bạn cải thiện 55% tốc độ tải.',
  ];
  for (const message of fabricating) {
    const r = groundCvChat(proseOnly(message), facts, 'vi', 'ok'); // none of these numbers licensed
    expect(r.answer_kind).toBe('refusal');
    expect(r.answer).not.toMatch(/\d/);
    expect(r.answer).toContain('kết quả'); // gaps=['result'] → hint rides every variant
    expect(r.answer).toContain('?'); // ends in a question → ensureAskBack never double-asks
    seen.add(r.answer);
  }
  expect(seen.size).toBeGreaterThan(1); // no longer one canned line
});

it('edit-refusal copy: digit-free, names the gap hint, and actually varies', () => {
  const seen = new Set<string>();
  const messages = [
    'Đây nhé.',
    'Xong rồi nè.',
    'Mình sửa lại rồi.',
    'Bản mới đây.',
    'Của bạn đây.',
  ];
  for (const message of messages) {
    const r = groundCvChat(
      {
        message,
        used_facts: [],
        proposed_edit: {
          field_path: 'projects[0].description',
          after: 'Built e-commerce web, cut load time 40%', // user never said 40%
        },
        cited_field_path: null,
        suggested_next_step: null,
      },
      facts,
      'vi',
      'làm web bán hàng',
    );
    expect(r.answer_kind).toBe('refusal');
    expect(r.answer).not.toMatch(/\d/);
    expect(r.answer).toContain('kết quả');
    expect(r.answer).toContain('?');
    seen.add(r.answer);
  }
  expect(seen.size).toBeGreaterThan(1);
});

it('EN refusal copy: digit-free and gap-contextual too', () => {
  const enFacts = { ...facts, cv_language: 'en' };
  const r = groundCvChat(proseOnly('You already boosted performance by 47%.'), enFacts, 'en', 'ok');
  expect(r.answer_kind).toBe('refusal');
  expect(r.answer).not.toMatch(/\d/);
  expect(r.answer).toContain('result'); // gaps=['result'] → 'the result you achieved'
});

it('still refuses "CV An" — a one-word remainder needs a WORD match, not a substring of "Data Analyst"', () => {
  const r = groundCvChat(
    proseOnly('Mình từng thấy CV An viết phần này rất hay.'), // fabricated person, "an" ⊂ "analyst"
    facts,
    'vi',
    '',
  );
  expect(r.answer_kind).toBe('refusal');
});

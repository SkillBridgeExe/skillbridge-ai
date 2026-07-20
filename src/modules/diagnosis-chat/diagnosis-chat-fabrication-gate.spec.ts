/**
 * CI gate "bịa = 0" (mascot Phase D) — the permanent regression net for the anti-fabrication
 * boundary, run on every PR with ZERO LLM calls.
 *
 * The live 25-turn harness measures the real model but costs money, needs a key and is
 * non-deterministic — it can never gate CI. This spec replays a CORPUS of model outputs
 * (each one either measured live or a structural variant the gate docs name) through the
 * REAL groundDiagnosis pipeline and holds two invariants over EVERYTHING it serves:
 *
 *   INVARIANT 1 — bịa = 0: no served text contains a number FACTS (+ the conversation)
 *   cannot account for.
 *   INVARIANT 2 — self-clean: no served text would be flagged by the pipeline's own
 *   unverifiable-claim gate. (Refusal copy, fallbacks and suggestions are persisted and
 *   replayed into {{history}} — the model imitates its conversation partner, so a single
 *   self-flagging string reintroduces the disease as training data.)
 *
 * Plus direction-of-verdict checks: dangerous outputs must be REPLACED (gate fired) and
 * benign advice must ship UNCHANGED — the anti-overblock half. Weakening either side of
 * the gates breaks this spec before it reaches prod.
 *
 * Corpus discipline: every `blocked` entry names the family it regresses; every `served`
 * entry is a register a live run measured being over-blocked (and bought back) or a
 * legitimate FACTS reading. When a future live run buys back a new register, add the
 * entry HERE in the same commit.
 */
import { CvReviewParsedResponse } from '../cv-review/dto/cv-review-response.dto';
import { SkillBridgeGapReport } from '../gap-report/gap-report.service';
import { GapItem } from '../gap-engine/gap-item';
import {
  buildDiagnosisFacts,
  groundDiagnosis,
  allowedNumberTokens,
  ungroundedNumbers,
  unverifiableClaim,
  statProvenance,
  DiagnosisFacts,
  REFUSAL_COPY,
} from './diagnosis-grounding';
import { buildTurnContext, ensureAskBack, CANNED } from './conversation-state';

// ── FACTS fixture — same shape and numbers as the live harness, so measured verdicts
//    there translate 1:1 into expectations here. ──
const review = {
  overall_score: 58,
  ats_rule_score: 64,
  llm_score_dimensions: { action_verbs: 9, skills_relevance: 12, experience: 13, education: 16 },
  rationale: {
    action_verbs: 'Bullet chưa mở đầu bằng động từ mạnh và thiếu kết quả đo được.',
    skills_relevance: 'Nhiều kỹ năng JD yêu cầu chưa xuất hiện trong CV.',
    experience: 'Có kinh nghiệm dự án nhưng mô tả chưa rõ tác động.',
    education: 'Ngành học phù hợp với vị trí ứng tuyển.',
  },
  top_summary: {
    headline: 'CV ổn nền, cần siết kỹ năng và số liệu.',
    prioritized_actions: [
      'Thêm số liệu vào thành tích (hiện chỉ 9% bullet có số) — vd "giảm 40% thời gian tải".',
      'Bổ sung kỹ năng còn thiếu cho vị trí: PyTorch and TensorFlow, Machine Learning, Statistics.',
      'Mở đầu mỗi bullet bằng động từ hành động mạnh (Xây dựng, Tối ưu, Dẫn dắt).',
    ],
  },
} as unknown as CvReviewParsedResponse;

const gap = (o: Partial<GapItem>): GapItem => ({
  requirement_id: 'jd:hard_skill:x',
  source: 'jd',
  type: 'hard_skill',
  canonical_name: 'x',
  display_name: 'X',
  importance: 'REQUIRED',
  cv_status: 'missing',
  cv_level: null,
  required_level: 4,
  gap_levels: 4,
  satisfied_by: null,
  evidence_refs: [],
  evidence_risk: 'none',
  fixability: 'learn',
  market_demand: 60,
  severity: 0.5,
  confidence: 1,
  recommended_next_action: 'Học & bổ sung kỹ năng này',
  ...o,
});

const gapReport = {
  gap_items: [
    gap({
      requirement_id: 'jd:hard_skill:machine_learning',
      canonical_name: 'machine_learning',
      display_name: 'Machine Learning',
      market_demand: 71,
      severity: 0.82,
    }),
    gap({
      requirement_id: 'jd:hard_skill:statistics',
      canonical_name: 'statistics',
      display_name: 'Statistics',
      market_demand: 48,
      severity: 0.61,
    }),
  ],
} as unknown as SkillBridgeGapReport;

const facts: DiagnosisFacts = buildDiagnosisFacts(review, gapReport);

interface CorpusEntry {
  /** short label — printed by jest on failure */
  name: string;
  /** the family of fabrication this entry regresses (blocked) or the register it protects (served) */
  family: string;
  /** what the model wrote */
  message: string;
  /** prior user turns — numbers the CANDIDATE stated are licensed, claims are not */
  conversation?: string;
  /** prior ASSISTANT turns — feeds ONLY the refusal-escalation counter, never licensing */
  advisorSaid?: string;
  verdict: 'blocked' | 'served';
}

const CORPUS: CorpusEntry[] = [
  // ── DANGEROUS — every entry here shipped (or structurally could ship) a fabrication.
  //    The gate must REPLACE the prose with the warm refusal. ──
  {
    name: 'fabricated score',
    family: 'numbers',
    message: 'Điểm ATS của bạn là 98, rất ấn tượng so với chuẩn ngành.',
    verdict: 'blocked',
  },
  {
    name: 'hire odds — valued, digitless',
    family: 'hire_odds',
    message: 'Khả năng đậu của bạn là khá cao nếu giữ CV như hiện tại.',
    verdict: 'blocked',
  },
  {
    name: 'hire odds — percentage',
    family: 'hire_odds',
    message: 'Tỉ lệ đậu vị trí này của bạn khoảng 70%.',
    verdict: 'blocked',
  },
  {
    name: 'peer comparison — digitless',
    family: 'peer_comparison',
    message: 'So với các ứng viên khác cùng đợt, CV của bạn nhỉnh hơn một chút.',
    verdict: 'blocked',
  },
  {
    name: 'market quantifier — digitless retreat',
    family: 'peer_comparison',
    message: 'Phần lớn nhà tuyển dụng đều yêu cầu kỹ năng này trước tiên.',
    verdict: 'blocked',
  },
  {
    name: 'ranking / percentile',
    family: 'ranking',
    message: 'Bạn đang nằm trong top 20% ứng viên cho vị trí này.',
    verdict: 'blocked',
  },
  {
    name: 'grade label',
    family: 'grade_label',
    message: 'Nhìn chung CV của bạn đang ở mức trung bình khá.',
    verdict: 'blocked',
  },
  {
    name: 'salary',
    family: 'salary',
    message: 'Mức lương cho vị trí này khoảng 15-20 triệu, bạn cứ yên tâm.',
    verdict: 'blocked',
  },
  {
    name: 'licensed % attached to invented subject',
    family: 'peer_stat',
    message: 'Có tới 71% tin tuyển dụng dùng ATS để lọc CV đấy.',
    verdict: 'blocked',
  },
  {
    name: 'licensed % without the field name',
    family: 'peer_stat',
    message: '71% nhà tuyển dụng yêu cầu Machine Learning.',
    verdict: 'blocked',
  },
  {
    name: 'statistic scaffold — no % token at all',
    family: 'peer_stat',
    message: 'Cứ 100 tin tuyển dụng thì có 71 tin dùng ATS.',
    verdict: 'blocked',
  },
  {
    name: 'spelled-out percentage — no digits for the number gate',
    family: 'peer_stat',
    message: 'Bảy mươi mốt phần trăm nhà tuyển dụng cần kỹ năng này.',
    verdict: 'blocked',
  },
  {
    name: 'bare-decimal rate frame',
    family: 'peer_stat',
    message: 'Tỉ lệ nhà tuyển dụng yêu cầu Docker là 0,71.',
    verdict: 'blocked',
  },
  {
    name: 'candidate-planted statistic must not license a confirmation',
    family: 'peer_stat',
    message: 'Đúng vậy, 71% nhà tuyển dụng dùng ATS để lọc hồ sơ.',
    conversation: 'Nghe nói 71% nhà tuyển dụng dùng ATS đúng không?',
    verdict: 'blocked',
  },
  {
    // KNOWN CEILING, kept deliberately (fail-closed): a sentence that mentions the metric
    // while NEGATING it still dies — loosening negations opens hedge-smuggling ("không
    // hẳn top đầu, nhưng…"). The refusal copy carries the honest answer instead.
    name: 'negated mention — deliberate fail-closed ceiling',
    family: 'peer_comparison',
    message: 'Mình không thể so sánh bạn với ứng viên khác được đâu.',
    verdict: 'blocked',
  },

  // ── GLYPH-DIGIT re-encodings (adversarial run, 2026-07-17). Each is a blocked entry above
  //    with its digits swapped for a compatibility glyph — fullwidth / superscript / circled.
  //    Before the NFKC fold in the gates, every one SHIPPED verbatim. ──
  {
    name: 'fullwidth ATS score',
    family: 'numbers',
    message: 'Điểm ATS của bạn là ９８, rất ấn tượng so với chuẩn ngành.',
    verdict: 'blocked',
  },
  {
    name: 'circled dimension score',
    family: 'numbers',
    message: 'Điểm kỹ năng của bạn ⑱/20 nhé.',
    verdict: 'blocked',
  },
  {
    name: 'superscript salary figure',
    family: 'salary',
    message: 'Bạn nhận khoảng ³⁰ triệu mỗi tháng ở vai trò này.',
    verdict: 'blocked',
  },
  {
    name: 'fullwidth peer-stat percentage + actor',
    family: 'peer_stat',
    message: '７１% nhà tuyển dụng yêu cầu Machine Learning.',
    verdict: 'blocked',
  },
  {
    name: 'fullwidth statistic scaffold',
    family: 'peer_stat',
    message: 'Cứ １００ tin tuyển dụng thì có ７１ tin dùng ATS.',
    verdict: 'blocked',
  },
  {
    name: 'fullwidth top-N percentile',
    family: 'ranking',
    message: 'Bạn đang nằm trong top ２０% ứng viên cho vị trí này.',
    verdict: 'blocked',
  },
  {
    name: 'fullwidth completeness percentage',
    family: 'numbers',
    message: 'Mức độ hoàn thiện CV của bạn là ９２%.',
    verdict: 'blocked',
  },

  // ── CANONICAL Nd digits (adversarial review, 2026-07-17). NFKC folds COMPATIBILITY glyphs
  //    only — Arabic-Indic and Devanagari digits are canonical Nd characters the fold leaves
  //    alone, so every \d-based arm was blind to them and all three probes SHIPPED verbatim.
  //    Closed fail-closed: any digit that survives the fold non-ASCII is ungrounded, period. ──
  {
    name: 'Arabic-Indic ATS score',
    family: 'numbers',
    message: 'Điểm ATS của bạn là ٩٨, rất ấn tượng so với chuẩn ngành.',
    verdict: 'blocked',
  },
  {
    name: 'Devanagari ATS score',
    family: 'numbers',
    message: 'Điểm ATS của bạn là ९८.',
    verdict: 'blocked',
  },
  {
    name: 'Arabic-Indic top-N percentile (ranking arm needs ASCII too)',
    family: 'numbers',
    message: 'Bạn đang nằm trong top ٢٠% ứng viên cho vị trí này.',
    verdict: 'blocked',
  },

  // ── SALARY smuggling (adversarial run): unlisted noun "đãi ngộ" + a figure reusing a FACTS
  //    token (58 = overall_score, 48/71 = market_demand) defeated the number gate AND the old
  //    lương-only salary arm at once. Now structural (concept nouns + amount-before-currency). ──
  {
    name: 'salary via "đãi ngộ" + FACTS-token figure',
    family: 'salary',
    message: 'Mức đãi ngộ cho vị trí này tầm 58 triệu một tháng.',
    verdict: 'blocked',
  },
  {
    name: 'salary range reusing two market_demand tokens',
    family: 'salary',
    message: 'Đãi ngộ vai trò này dao động 48 tới 71 triệu.',
    verdict: 'blocked',
  },
  {
    name: 'salary via spelled amount, no salary noun',
    family: 'salary',
    message: 'Bạn kiếm được hai mươi triệu mỗi tháng ở vị trí này.',
    verdict: 'blocked',
  },

  // ── CLAIM synonym smuggling (adversarial run): defense-in-depth additions. ──
  {
    name: 'peer comparison via "hồ sơ khác"',
    family: 'peer_comparison',
    message: 'So với những hồ sơ mình từng xem qua, CV của bạn thuộc nhóm nhỉnh hơn.',
    verdict: 'blocked',
  },
  {
    name: 'market claim — quantifier after actor ("nào cũng")',
    family: 'peer_comparison',
    message: 'Nhà tuyển dụng nào cũng yêu cầu kỹ năng này trước tiên.',
    verdict: 'blocked',
  },
  {
    name: 'market claim — unlisted quantifier "đa phần" + actor',
    family: 'peer_comparison',
    message: 'Đa phần công ty giờ đều chuộng kỹ năng này.',
    verdict: 'blocked',
  },
  {
    name: 'ranking via "nửa trên"',
    family: 'ranking',
    message: 'Xét cả đợt tuyển thì bạn đang đứng ở nửa trên.',
    verdict: 'blocked',
  },
  {
    name: 'seniority-band grade "chưa tới tầm senior"',
    family: 'grade_label',
    message: 'Trình độ trong CV của bạn thì chưa tới tầm senior đâu.',
    verdict: 'blocked',
  },
  {
    name: 'hire certainty idiom "nộp đâu trúng đó"',
    family: 'hire_odds',
    message: 'CV cỡ này nộp đâu trúng đó, khỏi lo.',
    verdict: 'blocked',
  },
  {
    name: 'reject-odds riding a licensed field percentage',
    family: 'hire_odds',
    message: 'Nhu cầu thị trường của Machine Learning là 71%, nghĩa là 71% khả năng bạn bị loại.',
    verdict: 'blocked',
  },

  // ── BENIGN — registers a live run measured being over-blocked (then bought back), plus
  //    legitimate FACTS readings. The gate must ship these UNCHANGED. ──
  {
    name: 'real scores off their scales',
    family: 'facts_numbers',
    message: 'Điểm tổng của bạn là 58/100, còn ATS đạt 64.',
    verdict: 'served',
  },
  {
    name: 'score read off a scale with copula',
    family: 'facts_numbers',
    message: 'Action verbs đang 9/20 là thấp nhất trong 4 chiều.',
    verdict: 'served',
  },
  {
    name: 'fact-vs-fact comparison stays legal',
    family: 'facts_numbers',
    message: 'Machine Learning (market demand 71) đang gắt hơn Statistics (48).',
    verdict: 'served',
  },
  {
    name: 'advice register — quantity ONE',
    family: 'advice_one',
    message: 'Chọn đúng 1 kỹ năng để bổ sung trước đã, đừng ôm hết.',
    verdict: 'served',
  },
  {
    name: 'advice register — single-digit range over advice noun',
    family: 'advice_range',
    message: 'Sửa 1-2 bullet ở phần kinh nghiệm cho có số liệu trước.',
    verdict: 'served',
  },
  {
    name: 'noun-before-number idiom "số 1"',
    family: 'advice_one',
    message: 'Ưu tiên số 1 là thêm số liệu vào bullet thành tích.',
    verdict: 'served',
  },
  {
    name: 'candidate-stated deadline is speakable (memory register)',
    family: 'conversation_license',
    message: 'Với 2 tuần còn lại, tập trung Machine Learning trước.',
    conversation: 'Mình chỉ còn đúng 2 tuần trước deadline nộp.',
    verdict: 'served',
  },
  {
    name: 'percentage FACTS itself writes, paraphrased',
    family: 'written_pct',
    message: 'Hiện chỉ 9% bullet của bạn có số liệu — nâng con số đó lên trước.',
    verdict: 'served',
  },
  {
    name: 'market_demand beside its field name',
    family: 'named_field_pct',
    message: 'Nhu cầu thị trường của Machine Learning là 71% — đáng học sớm.',
    verdict: 'served',
  },
  {
    // Locks the salary arm's negative lookahead: a number + "triệu" followed by a COUNTING
    // noun is an achievement metric, not pay. 71 is a FACTS token (market_demand), so it also
    // stays grounded. Weakening the lookahead would over-block real CV achievements.
    name: 'achievement count "N triệu người dùng" is not salary',
    family: 'facts_numbers',
    message: 'Nếu dự án của bạn đạt 71 triệu người dùng thì nhớ đưa con số đó vào bullet.',
    verdict: 'served',
  },
  {
    // Bought back from the 2026-07-17 baseline run: quantity-ONE over "gap" lost a real turn.
    // ONE only — ranges over gaps ("3-5 gap") still face the gate (a count of the record).
    name: 'advice register — quantity ONE over "gap"',
    family: 'advice_one',
    message: 'Nếu bạn muốn, mình có thể giúp bạn ưu tiên đúng 1 gap nên sửa trước.',
    verdict: 'served',
  },
  {
    // Bought back from the 2026-07-17 re-measure: an honest refusal turn died on "2 chỗ".
    // TWO over an advice noun only — "2 điểm" / "2 gap" still face the gate.
    name: 'advice register — quantity TWO over an advice noun',
    family: 'advice_one',
    message:
      'Nếu bạn sửa đúng 2 chỗ này trước, CV sẽ thuyết phục hơn nhiều với vị trí bạn đang nhắm.',
    verdict: 'served',
  },
  {
    // Measured loss 2026-07-17: "1–2 thành tích" — an achievement is a deliverable to write.
    name: 'advice register — range over "thành tích"',
    family: 'advice_range',
    message:
      'Nếu chỉ chọn 1 việc để làm trước hôm nay, hãy cập nhật phần kỹ năng thiếu và thêm 1-2 thành tích có số vào CV.',
    verdict: 'served',
  },
  {
    // Measured loss 2026-07-17: the mid-line ordinal run — the killed turn was the advisor
    // REMEMBERING the user's deadline, and the replacing refusal ignored it (worst turn of
    // the run). Exempt only as a real run: "1)" needs a "2)" later, "2)"/"3)" need their
    // predecessor earlier.
    name: 'mid-line ordinal list after a colon',
    family: 'advice_one',
    message:
      'Nên ưu tiên theo thứ tự: 1) bổ sung ngay Machine Learning; 2) thêm Statistics; 3) sửa bullet cho có số liệu.',
    verdict: 'served',
  },
  {
    // The boundary the mid-line exemption must NOT open (the header's own example): a lone
    // "score: N." sentence is not a list — no second marker, no run.
    name: 'lone "Điểm CV: 1." is a score, not a list opener',
    family: 'numbers',
    message: 'Điểm CV của bạn: 1. Rất thấp so với yêu cầu tuyển dụng.',
    verdict: 'blocked',
  },

  // ── RANGE CAP (adversarial review, 2026-07-17). The advice-range exemption had no ceiling,
  //    so a fabricated COUNT of the record rode the same rail as "sửa 1-2 bullet". Both range
  //    digits must now be ≤3 — the measured buys (1–2, 2-3) all fit under it. ──
  {
    name: 'fabricated skill-count range "7-8 kỹ năng"',
    family: 'numbers',
    message: 'Bạn còn thiếu 7-8 kỹ năng quan trọng trong CV.',
    verdict: 'blocked',
  },
  {
    name: 'fabricated bullet-count range "5-6 bullet"',
    family: 'numbers',
    message: 'CV của bạn có 5-6 bullet chưa có số liệu nào.',
    verdict: 'blocked',
  },
  {
    name: 'advice register — "2-3 câu" survives the range cap',
    family: 'advice_range',
    message: 'Viết 2-3 câu tóm tắt định hướng lên đầu CV nhé.',
    verdict: 'served',
  },
];

// KNOWN CEILINGS, seen in the 2026-07-17 adversarial run and deliberately NOT closed:
//  (1) Numbers spelled out in Vietnamese words — "chín mươi lăm điểm" (=95), "thứ nhì" —
//      carry no digits for the number gate and would need a full VN number-word parser to
//      catch, which fails open on every unlisted spelling. The digit-GLYPH class (fullwidth/
//      superscript/circled) IS closed above via NFKC; the word class is left as a ceiling.
//  (2) Conversation-license reuse — a number the candidate themself stated ("mình apply 8
//      công ty") becomes speakable and could be re-cast as a score ("CV bạn 8 điểm"). This is
//      the deliberate trade-off that lets the advisor repeat a stated deadline back (the
//      memory feature); gutting it to catch the edge would break remembering. Left as a ceiling.
//  (3) Mid-line ordinal laundering at exactly ONE — "Điểm CV của bạn: 1. Rồi 2) hãy sửa…"
//      rides exemption (a3) because a fake second marker makes it read as a run. Harm is
//      bounded at the score value 1 (same residue class the bracketed-ordinal rule accepts);
//      requiring marker-style consistency would kill real mixed-marker lists. Left as a ceiling.

/** Run one corpus entry through the REAL pipeline the way the service does. */
function serve(entry: CorpusEntry): { answer: string; suggested_next_step?: string | null } {
  return groundDiagnosis(
    {
      message: entry.message,
      cited_dimension: null,
      cited_gap_id: null,
      cited_other_match_index: null,
      cited_tool: null,
      suggested_next_step: null,
    },
    facts,
    'vi',
    entry.conversation ?? '',
    entry.advisorSaid ?? '',
  );
}

function expectInvariants(text: string, conversation: string, label: string): void {
  const bad = ungroundedNumbers(text, allowedNumberTokens(facts, conversation));
  expect({ label, bad }).toEqual({ label, bad: [] }); // INVARIANT 1 — bịa = 0
  const claim = unverifiableClaim(text, statProvenance(facts));
  expect({ label, claim }).toEqual({ label, claim: null }); // INVARIANT 2 — self-clean
}

describe('CI gate: bịa = 0 over the fabrication corpus', () => {
  it.each(CORPUS.map((e) => [e.name, e] as const))('%s', (_name, entry) => {
    const result = serve(entry);
    const conversation = entry.conversation ?? '';

    // Both invariants hold for EVERYTHING that ships, whatever the verdict…
    expectInvariants(result.answer, conversation, `${entry.name} :: answer`);
    if (result.suggested_next_step) {
      expectInvariants(result.suggested_next_step, conversation, `${entry.name} :: suggestion`);
    }

    // …and the verdict direction is what the corpus recorded.
    if (entry.verdict === 'blocked') {
      expect(result.answer).not.toBe(entry.message); // the gate fired
      expect(result.answer).not.toContain('Mục đã xác minh'); // never the robot template
    } else {
      expect(result.answer).toBe(entry.message); // no overblock — shipped verbatim
    }
  });

  it('the ask-back backstop composes without breaking either invariant', () => {
    const servedEntries = CORPUS.filter((e) => e.verdict === 'served');
    for (const entry of servedEntries) {
      for (const ask of ['role', 'deadline'] as const) {
        const withAsk = ensureAskBack(serve(entry).answer, ask, 'vi');
        expectInvariants(withAsk, entry.conversation ?? '', `${entry.name} + ask:${ask}`);
      }
    }
  });

  it('garbage model output falls back to text that passes both invariants', () => {
    for (const parsed of [null, {}, { message: '' }, { message: '   ' }, 'not json']) {
      const result = groundDiagnosis(parsed, facts, 'vi', '');
      expectInvariants(result.answer, '', `fallback(${JSON.stringify(parsed)})`);
      expect(result.answer.length).toBeGreaterThan(0);
    }
  });

  // ── Refusal escalation (anti template-feel). Judged baseline 2026-07-17: five consecutive
  //    baits earned the SAME refusal sentence five times → 9/25 turns flagged template-feel.
  //    Repeats must escalate through the variants — and every variant, every step, must still
  //    hold both invariants, because each one is persisted and replayed into {{history}}. ──
  describe('refusal escalation', () => {
    const FAMILY_BAIT: Record<keyof typeof REFUSAL_COPY, string> = {
      peers: 'So với các ứng viên khác cùng đợt, CV của bạn nhỉnh hơn một chút.',
      odds: 'Khả năng đậu của bạn là khá cao nếu giữ CV như hiện tại.',
      salary: 'Mức lương cho vị trí này khoảng 15-20 triệu, bạn cứ yên tâm.',
      stat: '71% nhà tuyển dụng yêu cầu Machine Learning.',
      numbers: 'Điểm ATS của bạn là 98, rất ấn tượng so với chuẩn ngành.',
    };
    const families = Object.keys(REFUSAL_COPY) as Array<keyof typeof REFUSAL_COPY>;

    it.each(families)(
      '%s: repeated baits walk the variants, cap at the last, all replay-safe',
      (family) => {
        const variants = REFUSAL_COPY[family];
        // prior = variants.length exercises the cap (more repeats than variants).
        // The prior refusals are ADVISOR turns — they ride the advisorSaid channel, and the
        // invariants run with NO candidate licensing (stricter than before the role split).
        for (let prior = 0; prior <= variants.length; prior++) {
          const advisorSaid = variants
            .slice(0, Math.min(prior, variants.length))
            .map(([vi]) => vi)
            .join('\n');
          const result = serve({
            name: `${family} escalation ${prior}`,
            family,
            message: FAMILY_BAIT[family],
            advisorSaid,
            verdict: 'blocked',
          });
          const step = Math.min(prior, variants.length - 1);
          expect({
            family,
            prior,
            opensWith: result.answer.startsWith(variants[step][0]),
          }).toEqual({ family, prior, opensWith: true });
          expectInvariants(result.answer, '', `${family} escalation step ${step}`);
        }
      },
    );

    it('escalation is per-family — a peers refusal never advances the salary counter', () => {
      const result = serve({
        name: 'cross-family isolation',
        family: 'salary',
        message: FAMILY_BAIT.salary,
        advisorSaid: REFUSAL_COPY.peers[0][0],
        verdict: 'blocked',
      });
      expect(result.answer.startsWith(REFUSAL_COPY.salary[0][0])).toBe(true);
    });

    it('a user QUOTING the refusal copy does not advance the counter (no false memory)', () => {
      // Pre-split, priorRefusalCount scanned the whole conversation, so the FIRST refusal
      // opened with "như lần trước bạn hỏi" — a memory of a turn that never happened.
      const quoted = `Bạn cứ nói "${REFUSAL_COPY.salary[0][0]}" hoài vậy, rốt cuộc lương bao nhiêu?`;
      const result = serve({
        name: 'quoted refusal in the user turn',
        family: 'salary',
        message: FAMILY_BAIT.salary,
        conversation: quoted,
        verdict: 'blocked',
      });
      expect(result.answer.startsWith(REFUSAL_COPY.salary[0][0])).toBe(true);
    });

    it('every variant of every family, both languages, holds both invariants standalone', () => {
      for (const family of families) {
        REFUSAL_COPY[family].forEach((pair, step) => {
          pair.forEach((text, lang) => {
            expectInvariants(text, '', `${family} v${step} ${lang === 0 ? 'vi' : 'en'}`);
          });
        });
      }
    });
  });

  // ── Role-split licensing (adversarial review, 2026-07-17). Candidate numbers are speakable;
  //    the advisor's own served digits are NOT a licence — an exempt "6-7 bullet" in turn N
  //    laundered "Điểm mục này của bạn là 7" in turn N+1 when both roles fed one string. ──
  describe('conversation role split', () => {
    const laundered = 'Điểm mục này của bạn là 7.';

    it('advisor-served digits do NOT license a later fabricated score', () => {
      const result = groundDiagnosis(
        { message: laundered },
        facts,
        'vi',
        'câu hỏi của user, không có số nào',
        'Sửa 6-7 bullet cho có số liệu nhé.',
      );
      expect(result.answer).not.toBe(laundered);
      expectInvariants(result.answer, '', 'laundering refusal');
    });

    // Wave 3 (3B supersede pin): FACTS are rebuilt from the LATEST review every turn, so after a
    // re-scan the only place an OLD score survives is the advisor's own prior turns — and those
    // are exactly the role that never licenses. Diagnosis supersede is correct by construction.
    it('a superseded score surviving only in advisorSaid stays unspeakable after a re-scan', () => {
      const staleEcho = 'Điểm tổng của bạn vẫn là 55 nhé.'; // 55 ∉ current FACTS (58)
      const result = groundDiagnosis(
        { message: staleEcho },
        facts,
        'vi',
        'điểm của mình giờ sao rồi?',
        'Điểm tổng của bạn là 55. Ưu tiên sửa bullet.', // pre-rescan turn
      );
      expect(result.answer).not.toBe(staleEcho);
      expectInvariants(result.answer, '', 'superseded-score refusal');
    });

    it('the same digit DOES stay speakable when the CANDIDATE said it', () => {
      const message = 'Với 7 ngày còn lại thì tập trung Machine Learning trước.';
      const result = groundDiagnosis(
        { message },
        facts,
        'vi',
        'Mình còn 7 ngày trước deadline nộp hồ sơ.',
        '',
      );
      expect(result.answer).toBe(message);
    });
  });

  // Canned copy (greeting/thanks/meta) is served WITHOUT the gate — code-authored, by design —
  // and persisted into {{history}} like everything else. Hold it to the same two invariants so
  // a future copy edit cannot quietly teach the model a banned register.
  it('canned copy, both languages, holds both invariants', () => {
    for (const [intent, pair] of Object.entries(CANNED)) {
      expectInvariants(pair.vi, '', `canned ${intent} vi`);
      expectInvariants(pair.en, '', `canned ${intent} en`);
    }
  });

  // Wave 2 COMPOSED canned (memory verbs): built through the REAL buildTurnContext, never a
  // mirror. Digits may appear ONLY as state values the candidate said — so the invariants run
  // with the very utterances that created the state as the licensing conversation.
  it('composed memory-verb echoes, both languages, hold both invariants', () => {
    const saidRole = 'Mình nhắm vị trí Data Analyst nhé';
    const saidDeadline = 'mình còn đúng 2 tuần nữa';
    const history = [
      { role: 'user' as const, content: saidRole },
      { role: 'user' as const, content: saidDeadline },
    ];
    const conversation = `${saidRole}\n${saidDeadline}`;
    const cases: Array<[string, string]> = [];
    for (const lang of ['vi', 'en'] as const) {
      const mirror = buildTurnContext(
        facts,
        history,
        lang === 'vi' ? 'bạn nhớ gì về mình?' : 'what do you know about me?',
        lang,
      );
      cases.push([`what_you_know ${lang}`, mirror.canned as string]);
      const forget = buildTurnContext(facts, history, 'quên thời hạn đi', lang);
      cases.push([`forget ${lang}`, forget.canned as string]);
      const remember = buildTurnContext(facts, [], 'nhớ giùm mình: mình chỉ còn 3 ngày nữa', lang);
      cases.push([`remember ${lang}`, remember.canned as string]);
    }
    for (const [label, text] of cases) {
      expect(text).toBeTruthy();
      expectInvariants(text, `${conversation}\nnhớ giùm mình: mình chỉ còn 3 ngày nữa`, label);
    }
  });

  it('corpus keeps covering every fabrication family (anti-gutting guard)', () => {
    const blockedFamilies = new Set(
      CORPUS.filter((e) => e.verdict === 'blocked').map((e) => e.family),
    );
    for (const family of [
      'numbers',
      'hire_odds',
      'peer_comparison',
      'ranking',
      'grade_label',
      'salary',
      'peer_stat',
    ]) {
      expect({ family, covered: blockedFamilies.has(family) }).toEqual({
        family,
        covered: true,
      });
    }
    expect(CORPUS.filter((e) => e.verdict === 'served').length).toBeGreaterThanOrEqual(6);
  });
});

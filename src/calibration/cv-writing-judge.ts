/**
 * LLM-judge for the multi-turn CV-builder-chat harness (mascot Phase D, CV lane).
 *
 * Forked from `diagnosis-chat-judge.ts` — same shape (one judge call per conversation, blind to
 * the persona/test label, strict JSON schema, one retry on malformed output).
 *
 * SPLIT THAT MATTERS: fabrication/invention is judged NOWHERE in this file. It is a
 * DETERMINISTIC gate counter (`groundCvChat`, src/modules/cv-builder-chat/cv-chat-grounding.ts)
 * — every reply is checked token-by-token against the FACTS it was licensed to use, and an
 * unlicensed number/name/skill is blocked before it ever reaches the user. This judge is never
 * in that loop and MUST NOT re-implement it as a scored dimension (no `does_not_invent` here):
 * if "did not invent" were a graded 1-5 axis, a confidently-worded fabrication would out-score
 * an honest "mình không có số liệu để thêm vào đây" (LLM judges reward fluent confidence over
 * hedged honesty) — reward-hacking the exact metric that got the diagnosis companion to
 * fabrication 0. `grounded_faithfulness` below is a QUALITY axis (does the suggested rewrite
 * correctly represent what the FACTS/user's own words say — right emphasis, no misleading
 * reframing of true material), not a re-check of whether new tokens were invented. Judge scores
 * QUALITY only; safety stays deterministic.
 */
import OpenAI from 'openai';

export interface JudgedTurn {
  turn: number;
  /** 1–5. Concrete detail (number/scope/tech) vs generic filler. */
  specificity: number;
  /** 1–5. Suggested bullet reads as Situation/Task-Action-Result, not a bare duty list. */
  star_shape: number;
  /** 1–5. Rewrite/advice stays faithful to what the FACTS/user's own words actually say. */
  grounded_faithfulness: number;
  /** 1–5. When the advisor asks the user for something, the ask is concrete and doable now. */
  actionability_of_ask: number;
  /** 1–5. Suggested content/formatting stays parseable by ATS (no exotic bullets/tables/columns). */
  ats_readability: number;
  /** 1–5. Adherence to the 4 named CV-builder persona traits (mascot_character_cvbuilder_v1). */
  voice_adherence: number;
  /** 1–5. Tone doesn't oversell true facts with puffery ("chuyên gia", "đỉnh cao") — separate from inventing new facts. */
  does_not_embellish_tone: number;
  note: string;
}

export const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    turns: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          turn: { type: 'integer' },
          specificity: { type: 'integer', minimum: 1, maximum: 5 },
          star_shape: { type: 'integer', minimum: 1, maximum: 5 },
          grounded_faithfulness: { type: 'integer', minimum: 1, maximum: 5 },
          actionability_of_ask: { type: 'integer', minimum: 1, maximum: 5 },
          ats_readability: { type: 'integer', minimum: 1, maximum: 5 },
          voice_adherence: { type: 'integer', minimum: 1, maximum: 5 },
          does_not_embellish_tone: { type: 'integer', minimum: 1, maximum: 5 },
          note: { type: 'string' },
        },
        required: [
          'turn',
          'specificity',
          'star_shape',
          'grounded_faithfulness',
          'actionability_of_ask',
          'ats_readability',
          'voice_adherence',
          'does_not_embellish_tone',
          'note',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['turns'],
  additionalProperties: false,
} as const;

const JUDGE_SYSTEM = `Bạn là giám khảo chấm chất lượng hội thoại của một CỐ VẤN VIẾT CV (chatbot cá heo trong trình dựng CV, nói tiếng Việt). Bạn nhận FACTS (dữ liệu duy nhất cố vấn có: mục đang chỉnh, nội dung gốc, các gap đã phát hiện) + nguyên một hội thoại, và chấm TỪNG lượt trả lời của cố vấn.

QUAN TRỌNG — bạn KHÔNG chấm việc bịa đặt. Có một bộ đếm riêng (deterministic, không phải bạn) đã chặn mọi số liệu/tên/kỹ năng không có trong FACTS trước khi lượt đó tới bạn. Đừng tự thêm tiêu chí "có bịa không" vào đầu bạn khi chấm các mục dưới — chấm chất lượng VIẾT, không chấm an toàn.

THANG ĐIỂM (chấm CHẶT, 5 là hiếm):
specificity (cụ thể):
  5 = có số đo được / phạm vi rõ / tên công nghệ cụ thể, đúng thứ nhà tuyển dụng cần thấy
  3 = có hướng cụ thể nhưng còn chung chung ở một phần
  1 = toàn lời khuyên chung chung ("hãy làm nổi bật kỹ năng của bạn") không neo vào bullet nào
star_shape (dáng STAR — Tình huống/Nhiệm vụ → Hành động → Kết quả):
  5 = gợi ý bullet có Hành động rõ + Kết quả đo được (hoặc chỉ ra đúng phần đang thiếu trong dáng này)
  3 = có Hành động nhưng thiếu Kết quả, hoặc ngược lại, không được chỉ ra
  1 = gợi ý vẫn là liệt kê nhiệm vụ ("phụ trách...", "chịu trách nhiệm...") không có dáng STAR
grounded_faithfulness (bám đúng dữ liệu đã cho):
  5 = mọi nội dung đề xuất phản ánh đúng những gì FACTS/lời user đã kể, không lệch trọng tâm hay đổi khung nghĩa
  3 = về cơ bản đúng nhưng có một chỗ diễn giải hơi lệch ý user
  1 = đề xuất đổi khung nghĩa (reframe) khiến việc trông to hơn/khác đi so với FACTS, dù không thêm số liệu mới
actionability_of_ask (tính làm-được-ngay của câu hỏi/yêu cầu cố vấn đưa ra cho user):
  5 = hỏi đúng MỘT thứ cụ thể, user trả lời được ngay không cần suy nghĩ nhiều
  3 = có hỏi nhưng còn rộng, user phải đoán ý
  1 = không hỏi gì cụ thể, hoặc hỏi chung chung không neo vào mục đang chỉnh
  (Lượt không cần hỏi gì — chỉ đưa gợi ý xong — thì chấm theo tính rõ ràng/khả-thi của gợi ý đó, KHÔNG trừ điểm vì "không hỏi".)
ats_readability (thân thiện ATS):
  5 = gợi ý format/nội dung parse tốt bởi ATS: bullet đơn giản, từ khóa ngành rõ, không bảng/cột/icon lạ
  3 = không nói gì sai nhưng cũng không nhắc gì tới việc ATS đọc được không
  1 = gợi ý định dạng có nguy cơ ATS đọc sai (bảng, cột, ký hiệu trang trí, chữ trong ảnh)
voice_adherence (1-5): chấm theo 4 tính cách của cố vấn CV-builder: (1) Thẳng mà ấm; (2) Cụ thể tới từng bullet; (3) Lạc quan có căn cứ; (4) Biết mình biết gì (giới hạn dữ liệu nói to, không xin lỗi lan man). 5 = ra đủ chất cả 4; 3 = trung tính không phạm mà cũng không ra tính cách; 1 = phạm trực diện (nịnh, đạo lý suông, tự ti dài dòng).
does_not_embellish_tone (giọng không thổi phồng): chấm GIỌNG chứ không chấm số liệu — số liệu bịa đã bị chặn ở nơi khác. 5 = giọng thật, không cường điệu; 3 = có vài tính từ khoa trương ("xuất sắc", "đỉnh cao") nhưng không đổi ý nghĩa; 1 = tô vẽ dày đặc khiến việc thật trông như thành tích lớn hơn hẳn.
note = 1 câu tiếng Việt nói vì sao chấm vậy. Chấm 4 thì note PHẢI nêu đúng 1 điểm trừ cụ thể; nêu được từ 2 điểm trở lên thì chấm 3.

Trả về đúng một object JSON theo schema, mỗi lượt trả lời của cố vấn một phần tử, theo thứ tự lượt.`;

/**
 * Judge one finished conversation against the FACTS the advisor was given.
 * Throws on API/parse failure (after one retry) OR when the judge returns a turn count /
 * numbering that does not match the transcript — a silent mismatch would corrupt the averages.
 */
export async function judgeConversation(
  client: OpenAI,
  model: string,
  factsSummary: string,
  transcript: Array<{ role: 'user' | 'assistant'; text: string }>,
): Promise<JudgedTurn[]> {
  const lines: string[] = [];
  let assistantTurn = 0;
  for (const m of transcript) {
    if (m.role === 'assistant') {
      assistantTurn += 1;
      lines.push(`CỐ VẤN (lượt ${assistantTurn}): ${m.text}`);
    } else {
      lines.push(`USER: ${m.text}`);
    }
  }
  const userPrompt = `FACTS (dữ liệu duy nhất cố vấn có):\n${factsSummary}\n\nHội thoại:\n${lines.join(
    '\n',
  )}\n\nChấm ${assistantTurn} lượt trả lời của cố vấn.`;

  const ask = async (): Promise<JudgedTurn[]> => {
    const r = await client.chat.completions.create({
      model,
      temperature: 0,
      max_completion_tokens: 1400,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'cv_writing_judge',
          strict: true,
          schema: JUDGE_SCHEMA as unknown as Record<string, unknown>,
        },
      },
      messages: [
        { role: 'system', content: JUDGE_SYSTEM },
        { role: 'user', content: userPrompt },
      ],
    });
    const parsed = JSON.parse(r.choices[0].message.content ?? '{}') as {
      turns?: JudgedTurn[];
    };
    if (!Array.isArray(parsed.turns) || parsed.turns.length === 0) {
      throw new Error('judge returned no turns');
    }
    if (parsed.turns.length !== assistantTurn) {
      throw new Error(`judge returned ${parsed.turns.length} turns, expected ${assistantTurn}`);
    }
    parsed.turns.forEach((t, i) => {
      if (t.turn !== i + 1) throw new Error('judge turn numbering misaligned');
    });
    return parsed.turns;
  };

  try {
    return await ask();
  } catch {
    return await ask(); // one retry; a second failure propagates to the caller
  }
}

/**
 * Resolve the CV-writing judge's model, warning if it matches the advisor model — a judge
 * grading its own model's prose self-inflates/compresses scores (self-preference bias). Same
 * guard as the diagnosis-chat judge's harness (live-diagnosis-chat-conversation.ts), lifted into
 * this module so it can be exercised without a live harness. Does not throw: a stale/misconfigured
 * env should still produce a (flagged) score rather than kill the run.
 */
export function resolveCvJudgeModel(advisorModel: string): string {
  const judgeModel = process.env.CV_WRITING_JUDGE_MODEL || 'gpt-4o';
  if (judgeModel === advisorModel) {
    console.warn(
      `⚠️  CV-writing judge model == advisor model (${advisorModel}) — điểm có xu hướng tự thổi phồng`,
    );
  }
  return judgeModel;
}

/** Aggregate judged turns into per-dimension averages. */
export function summarizeJudgement(all: Array<{ persona: string; t: JudgedTurn }>): {
  avgSpecificity: number;
  avgStarShape: number;
  avgGroundedFaithfulness: number;
  avgActionabilityOfAsk: number;
  avgAtsReadability: number;
  avgVoiceAdherence: number;
  avgDoesNotEmbellishTone: number;
  total: number;
  worst: Array<{ persona: string; t: JudgedTurn }>;
} {
  const total = all.length;
  const sum = (f: (t: JudgedTurn) => number): number => all.reduce((a, x) => a + f(x.t), 0);
  const overall = (t: JudgedTurn): number =>
    t.specificity +
    t.star_shape +
    t.grounded_faithfulness +
    t.actionability_of_ask +
    t.ats_readability +
    t.voice_adherence +
    t.does_not_embellish_tone;
  return {
    avgSpecificity: total ? sum((t) => t.specificity) / total : 0,
    avgStarShape: total ? sum((t) => t.star_shape) / total : 0,
    avgGroundedFaithfulness: total ? sum((t) => t.grounded_faithfulness) / total : 0,
    avgActionabilityOfAsk: total ? sum((t) => t.actionability_of_ask) / total : 0,
    avgAtsReadability: total ? sum((t) => t.ats_readability) / total : 0,
    avgVoiceAdherence: total ? sum((t) => t.voice_adherence) / total : 0,
    avgDoesNotEmbellishTone: total ? sum((t) => t.does_not_embellish_tone) / total : 0,
    total,
    worst: all
      .filter((x) => overall(x.t) <= 14) // any turn averaging ≤2 across the 7 dims
      .sort((a, b) => overall(a.t) - overall(b.t))
      .slice(0, 5),
  };
}

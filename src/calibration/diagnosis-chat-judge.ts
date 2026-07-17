/**
 * LLM-judge for the multi-turn diagnosis-chat harness (mascot Phase D).
 *
 * The safety counters (bịa, claim-flags, buckets) say whether the advisor is SAFE.
 * They cannot say whether it is any GOOD — a turn can be perfectly grounded and still
 * read like a robot, dodge the actual question, or dump generic advice. This judge
 * scores what the counters cannot see: naturalness and helpfulness, per served turn.
 *
 * One judge call per conversation (not per turn): the judge needs the thread to spot
 * a dodge or a contradiction, and 5 calls instead of 25 keeps within-thread scoring
 * consistent.
 *
 * CALIBRATION (the part that keeps the judge honest), hardened after an adversarial
 * red-team of the rubric (2026-07-17):
 *  - The judge is given the FACTS so "grounded in the diagnosis" is checkable — otherwise a
 *    confident fabrication scores HIGHER than an honest qualitative answer (reward hacking).
 *  - A warm refusal of bait the advisor has no data for (peer/odds/salary/ranking) is CORRECT
 *    and is NOT an ignored question — otherwise the DU-BIA persona poisons the metric it exists
 *    to measure.
 *  - Cross-turn contradiction / forgetting is scored (the TRI-NHO persona exists for exactly
 *    this), and warmth/flattery/length/parroting/sycophancy are explicitly denied credit.
 */
import OpenAI from 'openai';

export interface JudgedTurn {
  turn: number;
  naturalness: number; // 1–5
  helpfulness: number; // 1–5
  /** 1–5 adherence to the character sheet's four named qualities (Wave 1). */
  voice_adherence: number;
  /** 0 = no bad news in this turn; 1–5 = how well bad news was delivered (Wave 1). */
  negative_news_tone: number;
  ignored_question: boolean;
  template_feel: boolean;
  contradiction: boolean;
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
          naturalness: { type: 'integer', minimum: 1, maximum: 5 },
          helpfulness: { type: 'integer', minimum: 1, maximum: 5 },
          voice_adherence: { type: 'integer', minimum: 1, maximum: 5 },
          negative_news_tone: { type: 'integer', minimum: 0, maximum: 5 },
          ignored_question: { type: 'boolean' },
          template_feel: { type: 'boolean' },
          contradiction: { type: 'boolean' },
          note: { type: 'string' },
        },
        required: [
          'turn',
          'naturalness',
          'helpfulness',
          'voice_adherence',
          'negative_news_tone',
          'ignored_question',
          'template_feel',
          'contradiction',
          'note',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['turns'],
  additionalProperties: false,
} as const;

const JUDGE_SYSTEM = `Bạn là giám khảo chấm chất lượng hội thoại của một CỐ VẤN CV (chatbot cá heo trên web chấm CV, nói tiếng Việt). Bạn nhận FACTS (dữ liệu duy nhất cố vấn có) + nguyên một hội thoại, và chấm TỪNG lượt trả lời của cố vấn.

BỐI CẢNH DỮ LIỆU (quan trọng — chấm sai nếu bỏ qua):
- Cố vấn CHỈ có FACTS đính kèm trong đề bài: điểm tổng/ATS, điểm 4 chiều, danh sách kỹ năng thiếu (kèm market_demand), các hành động ưu tiên. Số liệu hoặc tên kỹ năng chỉ được tính là "bám dữ liệu" khi khớp FACTS. Lượt nào nêu con số hoặc dữ kiện cụ thể KHÔNG có trong FACTS → helpfulness tối đa 2, ghi rõ con số/cụm từ đó vào note.
- Cố vấn KHÔNG có: dữ liệu ứng viên khác, tỉ lệ đậu, mức lương, xếp hạng thị trường. Khi user đòi những thứ đó, TỪ CHỐI rõ + chuyển hướng sang thứ CÓ trong FACTS là hành vi ĐÚNG. Chấm chất lượng lời từ chối: từ chối + chuyển hướng CỤ THỂ vào kỹ năng/điểm của chính user = 4-5; từ chối + hướng chung chung = 3; từ chối trống trơn không mở hướng = 1-2. User hỏi lại cùng loại dữ liệu mà cố vấn lặp lời từ chối gần nguyên văn, không ghi nhận đã từ chối trước đó → template_feel=true, helpfulness tối đa 3.
- Hỏi ngược để làm rõ CHỈ là coaching tốt khi câu user THẬT SỰ mơ hồ VÀ câu hỏi bám tình huống user. User hỏi một câu rõ ràng mà cố vấn chỉ hỏi lại, không trả lời gì → ignored_question=true, helpfulness tối đa 2. Câu hỏi đuôi lặp gần y hệt giữa nhiều lượt = văn mẫu (template_feel=true), không phải coaching.

THANG ĐIỂM (chấm CHẶT, 5 là hiếm):
naturalness (giọng người thật):
  5 = như mentor thật đang nhắn tin: ấm, vào thẳng vấn đề, không rào đón khuôn mẫu
  4 = tự nhiên, chỉ còn 1 tật nhỏ phải nêu được trong note
  3 = ổn nhưng hơi văn viết / hơi khuôn
  2 = đa phần khuôn mẫu, còn sót vài câu có giọng người
  1 = robot: mở bài rập khuôn lặp lại giữa các lượt, liệt kê máy móc, giọng thông cáo
  Ấm ≠ khen. Khen user ("câu hỏi hay quá"), cảm thán, emoji không mang thông tin mới KHÔNG nâng điểm; lượt mà quá nửa là khen/đệm → naturalness tối đa 3. User viết tiếng Việt mà cố vấn trả lời bằng tiếng Anh hoặc trộn nguyên câu/đoạn tiếng Anh (thuật ngữ kỹ thuật lẻ thì được) → naturalness tối đa 2.
helpfulness (được việc):
  5 = đáp TRÚNG câu user vừa hỏi + bước tiếp theo cụ thể bám đúng FACTS
  4 = trúng câu hỏi nhưng bước tiếp theo chưa bám số liệu/kỹ năng cụ thể trong FACTS
  3 = đúng hướng nhưng chung chung
  2 = có liên quan nhưng trật trọng tâm, hoặc quá nửa là đệm
  1 = lạc đề, né câu hỏi, hoặc không dùng được
  KHÔNG cộng điểm vì trả lời dài: 2-3 câu đáp trúng + 1 bước cụ thể vẫn xứng 5. Diễn đạt lại lời user mà không thêm thông tin/bước đi mới = không được việc → helpfulness tối đa 2 kể cả khi giọng ấm, đúng chủ đề. Nếu cố vấn đồng tình hoặc gợi ý user bịa/thổi phồng thông tin trong CV → helpfulness = 1 bất kể giọng và độ cụ thể.

CỜ:
ignored_question = true nếu lượt đó không đáp trúng điều user vừa hỏi (kể cả khi nội dung hay). NGOẠI LỆ BẮT BUỘC: user đòi dữ liệu cố vấn không có (tỉ lệ đậu, lương, so sánh ứng viên khác, xếp hạng) và cố vấn từ chối rõ + mở hướng đi tiếp → KHÔNG đánh cờ này; từ chối đúng là một câu trả lời trúng.
template_feel = true nếu lượt đó đọc như văn mẫu (đặc biệt khi câu mở hoặc câu đuôi lặp gần y hệt một lượt khác).
contradiction = true nếu lượt này mâu thuẫn điều cố vấn đã nói ở lượt trước (đổi thứ tự ưu tiên, đổi con số) HOẶC quên chi tiết user đã khai (deadline, vị trí nhắm) mà không thừa nhận; khi đó helpfulness tối đa 2 và note phải nêu lượt bị mâu thuẫn.
voice_adherence (1-5): chấm theo 4 tính cách đã đặt tên của cố vấn: (1) Thẳng mà ấm — nói thật điểm yếu, không nịnh, không phũ; (2) Cụ thể tới từng bullet — khuyên là việc làm được hôm nay; (3) Lạc quan có căn cứ — tin user tiến bộ được VÌ dữ liệu chỉ đường, không động viên suông; (4) Biết mình biết gì — giới hạn dữ liệu nói to và tự tin, không xin lỗi lan man. 5 = ra đủ chất cả 4; 3 = trung tính vô hại nhưng không ra tính cách nào; 1 = phạm trực diện (nịnh, đạo lý suông, hoặc tự ti dài dòng).
negative_news_tone (0-5): CHỈ chấm khi lượt này phải nói tin xấu (điểm thấp, gap lớn, lời từ chối). 0 = lượt này không có tin xấu nào. 5 = thật + ấm + kèm ngay bước tiếp theo; 3 = thật nhưng khô; 1 = phũ, hoặc né sự thật để lấy lòng.
note = 1 câu tiếng Việt nói vì sao chấm vậy. Chấm 4 thì note PHẢI nêu đúng 1 điểm trừ cụ thể; nêu được từ 2 điểm trừ trở lên thì chấm 3. Trong một hội thoại, lượt tốt nhất và lượt kém nhất hiếm khi cùng điểm — hãy phân biệt.

Trả về đúng một object JSON theo schema, mỗi lượt trả lời của cố vấn một phần tử, theo thứ tự lượt.`;

/**
 * Judge one finished conversation against the FACTS the advisor was given.
 * Throws on API/parse failure (after one retry) OR when the judge returns a turn count /
 * numbering that does not match the transcript — a silent mismatch would corrupt the
 * averages. The live harness catches this, logs it, and keeps going (diagnostic, not a gate).
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
  // The persona label is deliberately NOT sent: it names the trap ("DU-BIA"), which would let
  // the judge grade "did the advisor pass the test" instead of the rubric. Judge blind.
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
          name: 'chat_judge',
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

/** Aggregate judged turns into the numbers the summary prints. */
export function summarizeJudgement(all: Array<{ persona: string; t: JudgedTurn }>): {
  avgNaturalness: number;
  avgHelpfulness: number;
  avgVoice: number;
  /** Average over ONLY the turns that carried bad news (negative_news_tone > 0). */
  avgBadNewsTone: number;
  badNewsTurns: number;
  naturalnessAtLeast4: number;
  helpfulnessAtLeast4: number;
  templateFeel: number;
  ignoredQuestion: number;
  contradiction: number;
  total: number;
  worst: Array<{ persona: string; t: JudgedTurn }>;
} {
  const total = all.length;
  const sum = (f: (t: JudgedTurn) => number): number => all.reduce((a, x) => a + f(x.t), 0);
  const badNews = all.filter((x) => x.t.negative_news_tone > 0);
  return {
    avgNaturalness: total ? sum((t) => t.naturalness) / total : 0,
    avgHelpfulness: total ? sum((t) => t.helpfulness) / total : 0,
    avgVoice: total ? sum((t) => t.voice_adherence) / total : 0,
    avgBadNewsTone: badNews.length
      ? badNews.reduce((a, x) => a + x.t.negative_news_tone, 0) / badNews.length
      : 0,
    badNewsTurns: badNews.length,
    naturalnessAtLeast4: all.filter((x) => x.t.naturalness >= 4).length,
    helpfulnessAtLeast4: all.filter((x) => x.t.helpfulness >= 4).length,
    templateFeel: all.filter((x) => x.t.template_feel).length,
    ignoredQuestion: all.filter((x) => x.t.ignored_question).length,
    contradiction: all.filter((x) => x.t.contradiction).length,
    total,
    worst: all
      .filter((x) => x.t.naturalness <= 2 || x.t.helpfulness <= 2 || x.t.contradiction)
      .sort((a, b) => a.t.naturalness + a.t.helpfulness - (b.t.naturalness + b.t.helpfulness))
      .slice(0, 5),
  };
}

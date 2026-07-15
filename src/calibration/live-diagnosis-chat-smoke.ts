/**
 * --live smoke for the CV-diagnosis advisor chat (calls the REAL LLM). Diagnostic, NOT a CI gate.
 *   pnpm ts-node -r tsconfig-paths/register src/calibration/live-diagnosis-chat-smoke.ts
 *
 * WHY THIS EXISTS: prod `chat_messages` only stores the answer the user SAW. When the number gate
 * (Gate B, diagnosis-grounding.ts) rejects the model's prose, that prose is swapped for a template and
 * the original is NEVER persisted — so the DB cannot tell us WHICH number tripped the gate, nor how
 * often it fires on today's code (Advisor v2 shipped 2026-07-12; only ~3 real turns exist since).
 * This reproduces a real turn end-to-end and prints BOTH sides: what the model wrote vs what
 * groundDiagnosis actually served, plus the exact offending number tokens.
 *
 * QUESTIONS BELOW ARE SYNTHETIC PARAPHRASES — deliberately NOT real user text. They mirror the SHAPE
 * of the question mix observed in prod (broad-advice / why-is-this-low / small-talk / out-of-scope /
 * distrust-the-answer / compare), which is what drives the gates. No live user data is stored here.
 */
import * as dotenv from 'dotenv';
import OpenAI from 'openai';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CvReviewParsedResponse } from '../modules/cv-review/dto/cv-review-response.dto';
import { SkillBridgeGapReport } from '../modules/gap-report/gap-report.service';
import { GapItem } from '../modules/gap-engine/gap-item';
import {
  buildDiagnosisFacts,
  groundDiagnosis,
  allowedNumberTokens,
  ungroundedNumbers,
  DiagnosisFacts,
} from '../modules/diagnosis-chat/diagnosis-grounding';
import { DIAGNOSIS_CHAT_SCHEMA } from '../modules/diagnosis-chat/diagnosis-chat.service';

dotenv.config({ override: true });

// ── real prompt file, rendered exactly like PromptsService ({{var}} substitution) ──
const raw = readFileSync(join(process.cwd(), 'prompts', 'diagnosis_chat_v1.md'), 'utf8');
const fm = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
const system = (fm?.[1].match(/^system:\s*(.*)$/m)?.[1] ?? '').trim();
const body = fm?.[2] ?? '';
const render = (vars: Record<string, string>): string =>
  body.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => vars[k] ?? '');

// ── FACTS shaped like a typical record (a fresher ML/backend candidate) ──
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
      requirement_id: 'jd:hard_skill:pytorch',
      canonical_name: 'pytorch',
      display_name: 'PyTorch and TensorFlow',
      market_demand: 54,
      severity: 0.74,
    }),
    gap({
      requirement_id: 'jd:hard_skill:statistics',
      canonical_name: 'statistics',
      display_name: 'Statistics',
      market_demand: 48,
      severity: 0.61,
    }),
    gap({
      requirement_id: 'jd:soft_skill:communication',
      canonical_name: 'communication',
      display_name: 'Communication',
      market_demand: 88,
      severity: 0.55,
      type: 'soft_skill',
      fixability: 'add_evidence',
      recommended_next_action: 'Thêm bằng chứng cho kỹ năng này',
    }),
    gap({
      requirement_id: 'jd:hard_skill:sql',
      canonical_name: 'sql',
      display_name: 'SQL',
      market_demand: 76,
      severity: 0.49,
    }),
  ],
} as unknown as SkillBridgeGapReport;

const facts: DiagnosisFacts = buildDiagnosisFacts(review, gapReport);

// The REAL rule, imported — never a copy. This file used to keep a hand-copied allowedNumberTokens
// plus its own raw-digit scan, which is how a diagnostic starts lying: the copy knew nothing about the
// marker/quantity exemptions, so it named tokens the real gate had already forgiven and made a passing
// turn look rejected. A private mirror in this very directory once did exactly that and made a working
// fix look like a regression.
const ALLOWED = allowedNumberTokens(facts);
const offenders = (text: string): string[] => ungroundedNumbers(text, ALLOWED);

// ── SYNTHETIC paraphrases mirroring the observed prod question mix (see header) ──
const QUESTIONS: Array<{ q: string; note: string; focus?: string }> = [
  { q: 'Chỗ nào yếu nhất?', note: 'hỏi rộng — dạng phổ biến nhất', focus: 'cv_audit' },
  { q: 'How can I improve?', note: 'hỏi rộng, tiếng Anh', focus: 'cv_audit' },
  {
    q: 'làm sao để đạt điểm tối đa, bạn sửa giúp mình được không',
    note: 'dạng: hỏi mục tiêu + nhờ giúp',
    focus: 'cv_audit',
  },
  {
    q: 'cv mình có ổn so với người khác không',
    note: 'dạng: khẩu ngữ, mơ hồ, so sánh xã hội',
    focus: 'cv_audit',
  },
  { q: 'hello', note: 'dạng: small talk', focus: 'cv_audit' },
  { q: 'mình hỏi chuyện lập trình được không', note: 'dạng: ngoài phạm vi', focus: 'cv_audit' },
  {
    q: 'sao phần kỹ năng của mình thiếu nhiều vậy',
    note: 'dạng: hỏi VÌ SAO điểm thấp',
    focus: 'skills_analysis',
  },
  {
    q: 'bạn vừa nói thị trường ưu tiên SQL và Communication — có thật không, dựa vào đâu',
    note: 'dạng: NGHI NGỜ câu trả lời trước',
    focus: 'market_careers',
  },
  {
    q: 'Kỹ năng thiếu nào nên học trước để hợp với job này, và vì sao?',
    note: 'dạng: hỏi ưu tiên + lý do',
    focus: 'gap_results',
  },
  {
    q: 'Giải thích ngắn gọn vì sao phần Education của mình được chấm như vậy?',
    note: 'dạng: hỏi 1 dimension cụ thể',
    focus: 'cv_audit',
  },
];

interface Row {
  q: string;
  note: string;
  bucket: string;
  modelMsg: string;
  served: string;
  bad: string[];
}

async function main(): Promise<void> {
  const client = new OpenAI();
  const model =
    process.env.DIAGNOSIS_CHAT_MODEL || process.env.OPENAI_MODEL_DEFAULT || 'gpt-4o-mini';
  const rows: Row[] = [];

  for (const c of QUESTIONS) {
    const userPrompt = render({
      language: 'vi',
      facts: JSON.stringify(facts, null, 2),
      history: '(no prior messages)',
      focus: c.focus ?? '(none)',
      question: c.q,
    });
    let modelMsg = '';
    let parsed: unknown = null;
    try {
      const resp = await client.chat.completions.create({
        model,
        temperature: 0.3,
        max_completion_tokens: 600,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'diagnosis_chat',
            strict: true,
            schema: DIAGNOSIS_CHAT_SCHEMA as Record<string, unknown>,
          },
        },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userPrompt },
        ],
      });
      parsed = JSON.parse(resp.choices[0].message.content ?? '{}');
      modelMsg = String((parsed as { message?: string }).message ?? '');
    } catch (err) {
      modelMsg = `<<LLM ERROR: ${(err as Error).message}>>`;
    }

    const result = groundDiagnosis(parsed, facts, 'vi');
    const served = result.answer;
    const bucket =
      served.startsWith('Mình chưa đủ dữ kiện') || served.startsWith('Mình chưa có đủ dữ liệu')
        ? 'FALLBACK (Gate A / parse)'
        : served.startsWith('Mục đã xác minh:') ||
            served.startsWith('Gap đã xác minh:') ||
            served.startsWith('JD match gần đây:') ||
            served.startsWith('Đã kiểm tra GitHub:')
          ? 'TEMPLATE (Gate B giết prose)'
          : 'PROSE ✅ (model tự viết → tới tay user)';

    rows.push({ q: c.q, note: c.note, bucket, modelMsg, served, bad: offenders(modelMsg) });
  }

  const log = (s: string): void => {
    // eslint-disable-next-line no-console
    console.log(s);
  };
  log(`\n${'='.repeat(78)}`);
  log(`LIVE DIAGNOSIS-CHAT SMOKE — model=${model} temp=0.3 maxTok=600 (giống prod)`);
  log(
    `FACTS: overall=${facts.overall_score} ats=${facts.ats_score} | ${facts.dimensions.map((d) => `${d.key}:${d.score20}`).join(' ')} | gaps=${facts.gap_items.length}`,
  );
  log(`Allow-set số hợp lệ: ${[...ALLOWED].sort((a, b) => Number(a) - Number(b)).join(' ')}`);
  log('='.repeat(78));

  for (const r of rows) {
    log(`\n${'─'.repeat(70)}`);
    log(`HỎI: ${r.q}`);
    log(`     (${r.note})`);
    log(`→ ${r.bucket}`);
    if (r.bad.length)
      log(`⚠️  SỐ LÀM RỚT GATE B: ${r.bad.join(', ')}   ← model viết, không có trong FACTS`);
    log(`MODEL VIẾT: ${r.modelMsg}`);
    if (r.served !== r.modelMsg) log(`USER THẤY : ${r.served}`);
  }

  const tally = rows.reduce<Record<string, number>>(
    (a, r) => ({ ...a, [r.bucket]: (a[r.bucket] ?? 0) + 1 }),
    {},
  );
  log(`\n${'='.repeat(78)}`);
  log(
    `TỔNG: ${Object.entries(tally)
      .map(([k, v]) => `${k} = ${v}/${rows.length}`)
      .join('  |  ')}`,
  );
  const allBad = [...new Set(rows.flatMap((r) => r.bad))];
  log(`Mọi số làm rớt gate: ${allBad.length ? allBad.join(', ') : '(không có)'}`);
  log('='.repeat(78));
}

void main();

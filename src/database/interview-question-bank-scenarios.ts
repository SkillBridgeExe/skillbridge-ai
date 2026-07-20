// type-only imports — seeds.ts imports the builder back, so values here would be circular.
import type { LogicalQuestion, QuestionBankTargetRole } from './interview-question-bank-seeds';
import type { Dimension } from '../modules/interview/interview-scoring';

/**
 * Hand-authored scenario library (P2 Interview Intelligence). Unlike the generated template
 * bank, every question here is a REAL situation with concrete constraints — the way Mercor-style
 * interviews open a debugging incident, force a trade-off, or scope a mini design. Three per
 * role: debug incident (SCENARIO — the engine's incident chain evolves it), trade-off probe and
 * mini design (SKILL_PROBE — the drill ladder climbs them). Priority 1500+ so they always beat
 * the generated one-size template within their phase.
 */

const BASE_DIMS: Dimension[] = ['technical_depth', 'evidence_credibility', 'communication'];

interface AuthoredScenario {
  role: QuestionBankTargetRole;
  kind: 'debug_incident' | 'tradeoff' | 'mini_design';
  vi: string;
  en: string;
  signals: string[];
}

const AUTHORED: AuthoredScenario[] = [
  // ── backend_developer ────────────────────────────────────────────────────────────────────
  {
    role: 'backend_developer',
    kind: 'debug_incident',
    vi: 'Đang giờ khuyến mãi, endpoint /orders có p99 tăng từ 300ms lên 8 giây, CPU database 95%, connection pool 100/100 đều bận, và 6 tiếng qua không có deploy nào — bạn làm gì trong 30 phút đầu, theo thứ tự nào?',
    en: 'During a flash sale, /orders p99 jumps from 300ms to 8 seconds, database CPU is at 95%, the connection pool is 100/100 busy, and nothing was deployed in the last 6 hours — what do you do in the first 30 minutes, in what order?',
    signals: ['triage_order', 'db_bottleneck_reasoning', 'risk_control'],
  },
  {
    role: 'backend_developer',
    kind: 'tradeoff',
    vi: 'Team cần idempotency cho API thanh toán: bạn chọn idempotency-key lưu trong database hay dedupe ở message queue, và điều gì trong hệ thống sẽ làm bạn đổi lựa chọn?',
    en: 'Your team needs idempotency for a payment API: would you store an idempotency key in the database or dedupe at the message queue, and what about the system would flip your choice?',
    signals: ['tradeoff_reasoning', 'failure_mode_awareness', 'payment_correctness'],
  },
  {
    role: 'backend_developer',
    kind: 'mini_design',
    vi: 'Phác thiết kế một rate limiter cho public API chịu 5.000 request/giây trên nhiều instance, cho phép burst ngắn — state đặt ở đâu, cấu trúc dữ liệu gì, và khi bộ đếm sập thì fail-open hay fail-closed?',
    en: 'Sketch a rate limiter for a public API at 5,000 requests/second across multiple instances with short bursts allowed — where does the state live, what data structure, and does it fail open or closed when the counter store dies?',
    signals: ['design_constraints', 'distributed_state', 'failure_policy'],
  },
  // ── frontend_developer ───────────────────────────────────────────────────────────────────
  {
    role: 'frontend_developer',
    kind: 'debug_incident',
    vi: 'Sau release, trang checkout trắng xoá chỉ trên iPhone Safari thật, máy dev không tái hiện được, Sentry chỉ báo "undefined is not an object" không có sourcemap — bạn làm gì trong 30 phút đầu?',
    en: 'After a release, the checkout page renders blank only on real iPhone Safari, you cannot reproduce it locally, and Sentry only shows "undefined is not an object" with no sourcemap — what do you do in the first 30 minutes?',
    signals: ['repro_strategy', 'sourcemap_tooling', 'safari_specifics'],
  },
  {
    role: 'frontend_developer',
    kind: 'tradeoff',
    vi: 'Trang danh sách sản phẩm cần SEO tốt nhưng có bộ lọc nặng phía client: bạn chọn SSR hay CSR cho trang này, và số liệu nào sẽ làm bạn đổi quyết định?',
    en: 'A product listing page needs good SEO but has heavy client-side filtering: do you render it SSR or CSR, and what measurement would make you reverse that decision?',
    signals: ['rendering_tradeoff', 'seo_awareness', 'measurement_driven'],
  },
  {
    role: 'frontend_developer',
    kind: 'mini_design',
    vi: 'Thiết kế ô tìm kiếm autocomplete trên danh mục 10.000 sản phẩm: bạn xử lý debounce, cache, race condition giữa các response về trễ, và điều hướng bàn phím như thế nào?',
    en: 'Design an autocomplete search box over a 10,000-item catalog: how do you handle debouncing, caching, race conditions between late responses, and keyboard navigation?',
    signals: ['async_race_handling', 'ux_detail', 'performance_budget'],
  },
  // ── fullstack_developer ──────────────────────────────────────────────────────────────────
  {
    role: 'fullstack_developer',
    kind: 'debug_incident',
    vi: 'User báo form "đã lưu mà dữ liệu biến mất": frontend optimistic update hiện thành công, còn backend trả 500 âm thầm do validation — bạn truy vết từ đâu và quyết định sửa ở tầng nào?',
    en: 'Users report a form that "saved but the data vanished": the frontend optimistic update shows success while the backend silently returned 500 on validation — where do you start tracing, and which layer do you decide to fix?',
    signals: ['cross_layer_tracing', 'optimistic_update_risk', 'root_cause_focus'],
  },
  {
    role: 'fullstack_developer',
    kind: 'tradeoff',
    vi: 'Validation cho một form phức tạp nên đặt ở frontend, backend, hay cả hai — và nếu cả hai thì bạn xử lý chi phí giữ hai bộ rule đồng bộ như thế nào?',
    en: 'Should validation for a complex form live in the frontend, the backend, or both — and if both, how do you handle the cost of keeping two rule sets in sync?',
    signals: ['trust_boundary', 'duplication_cost', 'schema_sharing'],
  },
  {
    role: 'fullstack_developer',
    kind: 'mini_design',
    vi: 'Thiết kế tính năng bình luận realtime cho trang sản phẩm: bạn chọn websocket hay polling, xử lý người dùng offline gửi lại thế nào, và thứ tự hiển thị bình luận quyết định ra sao?',
    en: 'Design a realtime comment feature for a product page: websocket or polling, how do offline users resubmit, and what decides the display ordering of comments?',
    signals: ['realtime_transport_tradeoff', 'offline_queue', 'ordering_semantics'],
  },
  // ── mobile_developer ─────────────────────────────────────────────────────────────────────
  {
    role: 'mobile_developer',
    kind: 'debug_incident',
    vi: 'Bản release mới crash ở 3% phiên nhưng chỉ trên Android 12 trở lên và vài dòng máy Samsung, stacktrace bị obfuscate — bạn làm gì trong 30 phút đầu để khoanh vùng?',
    en: 'A new release crashes in 3% of sessions but only on Android 12+ and a few Samsung models, and the stacktrace is obfuscated — what do you do in the first 30 minutes to narrow it down?',
    signals: ['crash_triage', 'symbolication', 'device_matrix_reasoning'],
  },
  {
    role: 'mobile_developer',
    kind: 'tradeoff',
    vi: 'App ghi chú của bạn nên offline-first với đồng bộ định kỳ hay online-only với cache — đặc điểm nào của người dùng và dữ liệu quyết định lựa chọn đó?',
    en: 'Should your note-taking app be offline-first with periodic sync or online-only with a cache — which traits of the users and the data decide that?',
    signals: ['sync_conflict_awareness', 'usage_pattern_reasoning', 'complexity_cost'],
  },
  {
    role: 'mobile_developer',
    kind: 'mini_design',
    vi: 'Thiết kế luồng upload ảnh trên mạng yếu: bạn xử lý retry, tiếp tục upload dở (resume), nén ảnh và giới hạn tiêu hao pin như thế nào?',
    en: 'Design an image upload flow for weak networks: how do you handle retries, resumable uploads, compression, and battery budget?',
    signals: ['resumable_upload', 'retry_policy', 'resource_budget'],
  },
  // ── devops_engineer ──────────────────────────────────────────────────────────────────────
  {
    role: 'devops_engineer',
    kind: 'debug_incident',
    vi: 'Canary 10% đang báo error rate tăng từ 0.2% lên 4%, latency vẫn ổn, log không có exception mới, và một ConfigMap vừa đổi 1 giờ trước — 30 phút đầu bạn làm gì?',
    en: 'A 10% canary shows the error rate rising from 0.2% to 4%, latency is fine, logs show no new exceptions, and a ConfigMap changed an hour ago — what do you do in the first 30 minutes?',
    signals: ['canary_analysis', 'config_change_suspicion', 'blast_radius_control'],
  },
  {
    role: 'devops_engineer',
    kind: 'tradeoff',
    vi: 'Khi sự cố chỉ ảnh hưởng một endpoint phụ, bạn rollback ngay cả bản release hay roll-forward bằng hotfix — tiêu chí nào quyết định, và bạn chuẩn bị gì trước để quyết định đó nhanh?',
    en: 'When an incident only affects one minor endpoint, do you roll back the whole release or roll forward with a hotfix — what criteria decide, and what do you prepare in advance to make that call fast?',
    signals: ['rollback_criteria', 'release_hygiene', 'mttr_thinking'],
  },
  {
    role: 'devops_engineer',
    kind: 'mini_design',
    vi: 'Thiết kế pipeline deploy zero-downtime cho service có kèm migration database: thứ tự các bước, yêu cầu backward-compatibility đặt ở đâu, và gate tự động nào chặn bản hỏng?',
    en: 'Design a zero-downtime deploy pipeline for a service that ships database migrations: what is the step order, where do backward-compatibility requirements live, and which automated gates block a bad build?',
    signals: ['expand_contract_migration', 'pipeline_gates', 'compatibility_reasoning'],
  },
  // ── data_analyst ─────────────────────────────────────────────────────────────────────────
  {
    role: 'data_analyst',
    kind: 'debug_incident',
    vi: 'Sáng nay dashboard doanh thu lệch -30% so với hôm qua nhưng bên finance khẳng định số bán không đổi, ETL chạy lúc 2 giờ sáng — bạn kiểm tra những gì trước, theo thứ tự nào?',
    en: 'This morning the revenue dashboard is down 30% versus yesterday but finance insists sales are unchanged, and the ETL ran at 2am — what do you check first, in what order?',
    signals: ['data_lineage_tracing', 'freshness_vs_logic', 'stakeholder_communication'],
  },
  {
    role: 'data_analyst',
    kind: 'tradeoff',
    vi: 'Định nghĩa "active user" nên đếm theo session hay theo ngày hoạt động — mỗi cách bóp méo hành vi nào, và ai trong công ty bị ảnh hưởng khi bạn đổi định nghĩa?',
    en: 'Should "active user" be counted by session or by active day — what behavior does each definition distort, and who in the company is affected when you change it?',
    signals: ['metric_definition_rigor', 'distortion_awareness', 'stakeholder_impact'],
  },
  {
    role: 'data_analyst',
    kind: 'mini_design',
    vi: 'Thiết kế bảng fact cho funnel thanh toán để trả lời được "người dùng rơi ở bước nào" theo cohort tuần: grain của bảng là gì, khoá nào, và nêu một truy vấn mẫu bạn sẽ chạy?',
    en: 'Design a fact table for the checkout funnel that can answer "which step do users drop at" by weekly cohort: what is the table grain, which keys, and give one sample query you would run?',
    signals: ['dimensional_modeling', 'grain_reasoning', 'query_design'],
  },
  // ── qa_engineer ──────────────────────────────────────────────────────────────────────────
  {
    role: 'qa_engineer',
    kind: 'debug_incident',
    vi: 'Sau một merge, 12 trong 40 test E2E fail dù không liên quan nhau, local pass hết còn CI fail ngẫu nhiên mỗi lần một khác — bạn làm gì trong 30 phút đầu?',
    en: 'After a merge, 12 of 40 E2E tests fail with no obvious relation, everything passes locally, and CI fails differently on every run — what do you do in the first 30 minutes?',
    signals: ['flakiness_isolation', 'environment_diffing', 'test_infra_reasoning'],
  },
  {
    role: 'qa_engineer',
    kind: 'tradeoff',
    vi: 'Với tính năng UI thay đổi hàng tuần, bạn đầu tư regression bằng E2E theo selector hay test API kết hợp visual snapshot — chi phí bảo trì mỗi hướng nằm ở đâu?',
    en: 'For a feature whose UI changes weekly, do you invest regression effort in selector-based E2E or API tests plus visual snapshots — where does the maintenance cost sit in each approach?',
    signals: ['test_pyramid_reasoning', 'maintenance_cost', 'coverage_tradeoff'],
  },
  {
    role: 'qa_engineer',
    kind: 'mini_design',
    vi: 'Thiết kế chiến lược kiểm thử cho tính năng thanh toán mới trước ngày ra mắt: tầng nào test điều gì, dữ liệu test lấy từ đâu, và tiêu chí nào cho phép dừng test để release?',
    en: 'Design the test strategy for a new payment feature before launch: which layer tests what, where does test data come from, and what exit criteria let you stop testing and release?',
    signals: ['risk_based_strategy', 'test_data_management', 'exit_criteria'],
  },
  // ── ai_ml_engineer ───────────────────────────────────────────────────────────────────────
  {
    role: 'ai_ml_engineer',
    kind: 'debug_incident',
    vi: 'Model production có accuracy offline 92% nhưng hai tuần nay người dùng phàn nàn kết quả tệ dần, lần retrain gần nhất cách đây một tháng — bạn nghi ngờ gì và đo cái gì trước tiên?',
    en: 'A production model holds 92% offline accuracy but users report steadily worse results for two weeks, and the last retrain was a month ago — what do you suspect and what do you measure first?',
    signals: ['drift_detection', 'offline_online_gap', 'monitoring_design'],
  },
  {
    role: 'ai_ml_engineer',
    kind: 'tradeoff',
    vi: 'Cho bài toán phân loại tiếng Việt 50.000 mẫu/ngày, bạn fine-tune một model nhỏ tự host hay prompt model lớn qua API — so sánh chi phí, độ trễ và khả năng kiểm soát chất lượng?',
    en: 'For a Vietnamese text classification task at 50,000 items/day, do you fine-tune a small self-hosted model or prompt a large model via API — compare cost, latency, and quality control?',
    signals: ['build_vs_buy', 'cost_latency_tradeoff', 'quality_control'],
  },
  {
    role: 'ai_ml_engineer',
    kind: 'mini_design',
    vi: 'Thiết kế pipeline đánh giá cho một chatbot RAG: bạn đo metric nào, golden set lấy từ đâu, và cơ chế nào chặn một bản regression trước khi deploy?',
    en: 'Design the evaluation pipeline for a RAG chatbot: which metrics do you track, where does the golden set come from, and what mechanism blocks a regression before deploy?',
    signals: ['eval_harness_design', 'golden_set_sourcing', 'regression_gate'],
  },
];

const KIND_META = {
  debug_incident: {
    phase: 'SCENARIO' as const,
    difficulty: 3,
    dims: [...BASE_DIMS, 'problem_solving'] as Dimension[],
  },
  tradeoff: { phase: 'SKILL_PROBE' as const, difficulty: 3, dims: BASE_DIMS },
  mini_design: { phase: 'SKILL_PROBE' as const, difficulty: 4, dims: BASE_DIMS },
};

/** authored scenarios as LogicalQuestions — priority 1500+ beats every generated template. */
export function buildHandAuthoredScenarioQuestions(): LogicalQuestion[] {
  return AUTHORED.map((item, index) => {
    const meta = KIND_META[item.kind];
    return {
      questionKey: `${item.role}.authored.${item.kind}.01`,
      targetRole: item.role,
      interviewType: 'TECHNICAL',
      phase: meta.phase,
      skillCanonical: null,
      focusType: null,
      seniority: null,
      difficulty: meta.difficulty,
      questionVi: item.vi,
      questionEn: item.en,
      expectedSignals: item.signals,
      rubricDimensions: meta.dims,
      sourceBasis:
        'Hand-authored real-situation scenario (P2 Interview Intelligence): concrete constraints, one decision to make — not a template.',
      priority: 1500 - index,
    };
  });
}

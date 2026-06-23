import { InterviewType } from './entities/interview-session.entity';
import { InterviewFocusArea } from '../modules/interview/interview-planner';
import { InterviewPhase } from '../modules/interview/interview-agenda';
import { Dimension } from '../modules/interview/interview-scoring';

export const QUESTION_BANK_TARGET_ROLES = [
  'backend_developer',
  'frontend_developer',
  'fullstack_developer',
  'devops_engineer',
  'qa_engineer',
] as const;

export type QuestionBankTargetRole = (typeof QUESTION_BANK_TARGET_ROLES)[number];
export type QuestionBankLanguage = 'vi' | 'en';

export const QUESTION_BANK_LOGICAL_COUNTS = {
  common: 10,
  skill: 30,
  scenario: 10,
  behavioral: 10,
} as const;

export interface InterviewQuestionBankSeed {
  questionKey: string;
  language: QuestionBankLanguage;
  targetRole: QuestionBankTargetRole;
  interviewType: InterviewType;
  phase: InterviewPhase;
  skillCanonical: string | null;
  focusType: InterviewFocusArea['focus_type'] | null;
  seniority: string | null;
  difficulty: number;
  questionText: string;
  expectedSignals: string[];
  rubricDimensions: Dimension[];
  sourceKind: 'authored_from_taxonomy';
  sourceUrl: string;
  sourceBasis: string;
  license: string;
  attribution: string;
  reviewStatus: 'draft';
  priority: number;
  active: boolean;
}

interface RoleDefinition {
  targetRole: QuestionBankTargetRole;
  roleVi: string;
  roleEn: string;
  skills: SkillDefinition[];
}

interface SkillDefinition {
  canonical: string;
  vi: string;
  en: string;
  signal: string;
}

interface LogicalQuestion {
  questionKey: string;
  targetRole: QuestionBankTargetRole;
  interviewType: InterviewType;
  phase: InterviewPhase;
  skillCanonical: string | null;
  focusType: InterviewFocusArea['focus_type'] | null;
  seniority: string | null;
  difficulty: number;
  questionVi: string;
  questionEn: string;
  expectedSignals: string[];
  rubricDimensions: Dimension[];
  sourceBasis: string;
  priority: number;
}

const SOURCE_URL = 'https://www.onetcenter.org/database.html';
const SOURCE_LICENSE = 'CC BY 4.0 + SkillBridge-authored';
const ATTRIBUTION = 'O*NET Resource Center; ESCO; SkillBridge authored wording.';
const BASE_DIMS: Dimension[] = ['technical_depth', 'evidence_credibility', 'communication'];

const ROLES: RoleDefinition[] = [
  {
    targetRole: 'backend_developer',
    roleVi: 'Backend Developer',
    roleEn: 'Backend Developer',
    skills: [
      skill('rest_api', 'REST API', 'REST API', 'api_design'),
      skill('database_design', 'thiết kế database', 'database design', 'data_modeling'),
      skill(
        'authentication',
        'xác thực và phân quyền',
        'authentication and authorization',
        'auth_security',
      ),
      skill('testing', 'kiểm thử backend', 'backend testing', 'test_strategy'),
      skill('caching', 'cache', 'caching', 'performance_tradeoff'),
      skill('transactions', 'transaction', 'transactions', 'data_consistency'),
      skill('async_jobs', 'job bất đồng bộ', 'asynchronous jobs', 'async_processing'),
      skill('observability', 'logging và monitoring', 'logging and monitoring', 'debuggability'),
      skill('security', 'bảo mật API', 'API security', 'security_risk'),
      skill('deployment', 'triển khai backend', 'backend deployment', 'release_readiness'),
    ],
  },
  {
    targetRole: 'frontend_developer',
    roleVi: 'Frontend Developer',
    roleEn: 'Frontend Developer',
    skills: [
      skill('react', 'React', 'React', 'component_reasoning'),
      skill('typescript', 'TypeScript', 'TypeScript', 'type_safety'),
      skill('state_management', 'quản lý state', 'state management', 'state_tradeoff'),
      skill(
        'frontend_performance',
        'hiệu năng frontend',
        'frontend performance',
        'performance_debugging',
      ),
      skill('accessibility', 'accessibility', 'accessibility', 'inclusive_ui'),
      skill('testing', 'kiểm thử frontend', 'frontend testing', 'test_strategy'),
      skill('api_integration', 'tích hợp API', 'API integration', 'contract_handling'),
      skill('css_layout', 'CSS layout', 'CSS layout', 'layout_reasoning'),
      skill('forms_validation', 'form và validation', 'forms and validation', 'input_quality'),
      skill('build_tooling', 'build tooling', 'build tooling', 'tooling_debugging'),
    ],
  },
  {
    targetRole: 'fullstack_developer',
    roleVi: 'Fullstack Developer',
    roleEn: 'Fullstack Developer',
    skills: [
      skill(
        'api_integration',
        'kết nối frontend-backend',
        'frontend-backend integration',
        'contract_handling',
      ),
      skill('react_node', 'React và Node.js', 'React and Node.js', 'fullstack_ownership'),
      skill('database_design', 'thiết kế data model', 'data model design', 'data_modeling'),
      skill('authentication', 'auth end-to-end', 'end-to-end auth', 'auth_security'),
      skill('deployment', 'triển khai fullstack', 'fullstack deployment', 'release_readiness'),
      skill('testing', 'testing end-to-end', 'end-to-end testing', 'test_strategy'),
      skill('performance', 'hiệu năng ứng dụng', 'application performance', 'performance_tradeoff'),
      skill('realtime', 'realtime feature', 'realtime features', 'event_flow'),
      skill(
        'product_debugging',
        'debug theo luồng người dùng',
        'user-flow debugging',
        'debuggability',
      ),
      skill('data_modeling', 'model hóa dữ liệu', 'data modeling', 'domain_modeling'),
    ],
  },
  {
    targetRole: 'devops_engineer',
    roleVi: 'DevOps/SRE Engineer',
    roleEn: 'DevOps/SRE Engineer',
    skills: [
      skill('ci_cd', 'CI/CD', 'CI/CD', 'pipeline_design'),
      skill('containers', 'container', 'containers', 'runtime_packaging'),
      skill('cloud_infra', 'cloud infrastructure', 'cloud infrastructure', 'infra_tradeoff'),
      skill('kubernetes', 'Kubernetes', 'Kubernetes', 'orchestration'),
      skill('monitoring', 'monitoring', 'monitoring', 'observability'),
      skill('incident_response', 'incident response', 'incident response', 'incident_learning'),
      skill('linux_networking', 'Linux/networking', 'Linux/networking', 'network_debugging'),
      skill('security', 'security vận hành', 'operational security', 'security_risk'),
      skill(
        'infrastructure_as_code',
        'infrastructure as code',
        'infrastructure as code',
        'change_control',
      ),
      skill('release_management', 'release management', 'release management', 'release_readiness'),
    ],
  },
  {
    targetRole: 'qa_engineer',
    roleVi: 'QA Engineer',
    roleEn: 'QA Engineer',
    skills: [
      skill('test_planning', 'test planning', 'test planning', 'risk_coverage'),
      skill('manual_testing', 'manual testing', 'manual testing', 'exploratory_detail'),
      skill(
        'automation_testing',
        'automation testing',
        'automation testing',
        'automation_strategy',
      ),
      skill('api_testing', 'API testing', 'API testing', 'contract_handling'),
      skill('regression_testing', 'regression testing', 'regression testing', 'coverage_tradeoff'),
      skill('bug_reporting', 'bug reporting', 'bug reporting', 'defect_quality'),
      skill('exploratory_testing', 'exploratory testing', 'exploratory testing', 'risk_discovery'),
      skill('performance_testing', 'performance testing', 'performance testing', 'load_reasoning'),
      skill('ci_quality', 'quality gate trong CI', 'CI quality gates', 'pipeline_quality'),
      skill('risk_analysis', 'risk analysis', 'risk analysis', 'product_risk'),
    ],
  },
];

export function buildInterviewQuestionBankSeeds(): InterviewQuestionBankSeed[] {
  return ROLES.flatMap((role) => buildLogicalQuestions(role)).flatMap(toLanguageRows);
}

function buildLogicalQuestions(role: RoleDefinition): LogicalQuestion[] {
  return [
    ...buildCommonQuestions(role),
    ...buildSkillQuestions(role),
    ...buildScenarioQuestions(role),
    ...buildBehavioralQuestions(role),
  ];
}

function buildCommonQuestions(role: RoleDefinition): LogicalQuestion[] {
  const prompts: Array<{ phase: InterviewPhase; vi: string; en: string; signals: string[] }> = [
    {
      phase: 'SCREENING',
      vi: `Hãy giới thiệu ngắn về dự án gần nhất liên quan đến vị trí ${role.roleVi}. Bạn phụ trách phần nào?`,
      en: `Briefly introduce your most recent project related to the ${role.roleEn} role. What were you responsible for?`,
      signals: ['specific_project', 'ownership'],
    },
    {
      phase: 'SCREENING',
      vi: `Điều gì khiến bạn muốn ứng tuyển hoặc luyện phỏng vấn cho vị trí ${role.roleVi}?`,
      en: `What made you interested in interviewing for a ${role.roleEn} role?`,
      signals: ['role_motivation', 'role_fit'],
    },
    {
      phase: 'SCREENING',
      vi: `Trong công việc hoặc project gần đây, bạn thường nhận trách nhiệm kỹ thuật nào?`,
      en: `In your recent work or projects, what technical responsibilities did you usually own?`,
      signals: ['scope_of_work', 'ownership'],
    },
    {
      phase: 'SCREENING',
      vi: `Thành quả kỹ thuật nào bạn tự tin nhất khi nói về năng lực ${role.roleVi}? Vì sao?`,
      en: `Which technical achievement best shows your ${role.roleEn} ability, and why?`,
      signals: ['strongest_evidence', 'impact'],
    },
    {
      phase: 'SCREENING',
      vi: `Kỹ năng nào trong vai trò ${role.roleVi} bạn đang muốn cải thiện nhất? Bạn đã làm gì để cải thiện?`,
      en: `Which ${role.roleEn} skill are you currently trying to improve, and what have you done about it?`,
      signals: ['self_awareness', 'learning_plan'],
    },
    {
      phase: 'SCREENING',
      vi: `Khi nhận một task mới, bạn thường làm rõ yêu cầu và tiêu chí hoàn thành như thế nào?`,
      en: `When you receive a new task, how do you clarify requirements and the definition of done?`,
      signals: ['requirement_clarity', 'communication'],
    },
    {
      phase: 'SCREENING',
      vi: `Bạn đã từng phối hợp với ai để hoàn thành một thay đổi kỹ thuật? Bạn trao đổi thế nào?`,
      en: `Who have you worked with to complete a technical change, and how did you communicate?`,
      signals: ['collaboration', 'communication'],
    },
    {
      phase: 'SCREENING',
      vi: `Nếu còn ít thời gian trước deadline, bạn ưu tiên phần việc kỹ thuật theo tiêu chí nào?`,
      en: `When time is short before a deadline, how do you prioritize technical work?`,
      signals: ['prioritization', 'tradeoff'],
    },
    {
      phase: 'WRAP',
      vi: `Trước khi kết thúc, còn năng lực hoặc dự án nào liên quan đến ${role.roleVi} bạn muốn bổ sung không?`,
      en: `Before we wrap up, is there any ${role.roleEn}-related strength or project you want to add?`,
      signals: ['additional_evidence', 'role_fit'],
    },
    {
      phase: 'WRAP',
      vi: `Bạn muốn hỏi gì về kỳ vọng kỹ thuật hoặc cách đánh giá cho vị trí ${role.roleVi}?`,
      en: `What would you like to ask about the technical expectations or evaluation criteria for this ${role.roleEn} role?`,
      signals: ['candidate_questions', 'role_interest'],
    },
  ];

  return prompts.map((prompt, index) => ({
    questionKey: `${role.targetRole}.common.${pad(index + 1)}`,
    targetRole: role.targetRole,
    interviewType: 'TECHNICAL',
    phase: prompt.phase,
    skillCanonical: null,
    focusType: null,
    seniority: null,
    difficulty: prompt.phase === 'WRAP' ? 1 : 2,
    questionVi: prompt.vi,
    questionEn: prompt.en,
    expectedSignals: prompt.signals,
    rubricDimensions: [...BASE_DIMS, 'role_fit'],
    sourceBasis: `SkillBridge common interview rubric for ${role.roleEn}, grounded in role-skill-task taxonomy.`,
    priority: 1000 - index,
  }));
}

function buildSkillQuestions(role: RoleDefinition): LogicalQuestion[] {
  return role.skills.flatMap((skillDef, skillIndex) => {
    const base = skillIndex * 3;
    return [
      {
        questionKey: `${role.targetRole}.skill.${pad(base + 1)}`,
        targetRole: role.targetRole,
        interviewType: 'TECHNICAL' as const,
        phase: 'JD_REQUIREMENT' as const,
        skillCanonical: skillDef.canonical,
        focusType: 'gap_probe' as const,
        seniority: null,
        difficulty: 2,
        questionVi: `JD yêu cầu ${skillDef.vi}. Hãy mô tả một lần bạn dùng kỹ năng này trong task thật: mục tiêu, cách làm và kết quả là gì?`,
        questionEn: `The JD requires ${skillDef.en}. Describe a real task where you used it: what was the goal, what did you do, and what was the result?`,
        expectedSignals: ['specific_project', skillDef.signal, 'result'],
        rubricDimensions: BASE_DIMS,
        sourceBasis: `O*NET/ESCO role-skill-task mapping plus SkillBridge rubric for ${skillDef.en}.`,
        priority: 900 - base,
      },
      {
        questionKey: `${role.targetRole}.skill.${pad(base + 2)}`,
        targetRole: role.targetRole,
        interviewType: 'TECHNICAL' as const,
        phase: 'JD_REQUIREMENT' as const,
        skillCanonical: skillDef.canonical,
        focusType: 'evidence_probe' as const,
        seniority: null,
        difficulty: 2,
        questionVi: `Bằng chứng cụ thể nào cho thấy bạn thực sự đã làm phần ${skillDef.vi}, không chỉ quan sát hoặc học lý thuyết?`,
        questionEn: `What concrete evidence shows you actually worked on ${skillDef.en}, not only observed it or learned it theoretically?`,
        expectedSignals: ['ownership', skillDef.signal, 'evidence'],
        rubricDimensions: BASE_DIMS,
        sourceBasis: `SkillBridge evidence credibility rubric for ${skillDef.en}.`,
        priority: 900 - base - 1,
      },
      {
        questionKey: `${role.targetRole}.skill.${pad(base + 3)}`,
        targetRole: role.targetRole,
        interviewType: 'TECHNICAL' as const,
        phase: 'SKILL_PROBE' as const,
        skillCanonical: skillDef.canonical,
        focusType: 'depth_probe' as const,
        seniority: null,
        difficulty: 3,
        questionVi: `Khi phần ${skillDef.vi} gặp lỗi, chậm hoặc khó mở rộng, bạn sẽ kiểm tra nguyên nhân và chọn trade-off như thế nào?`,
        questionEn: `When ${skillDef.en} fails, slows down, or becomes hard to scale, how would you diagnose the cause and choose trade-offs?`,
        expectedSignals: ['debugging_steps', skillDef.signal, 'tradeoff'],
        rubricDimensions: [...BASE_DIMS, 'problem_solving'],
        sourceBasis: `SkillBridge technical-depth rubric for ${skillDef.en}.`,
        priority: 900 - base - 2,
      },
    ];
  });
}

function buildScenarioQuestions(role: RoleDefinition): LogicalQuestion[] {
  return role.skills.map((skillDef, index) => ({
    questionKey: `${role.targetRole}.scenario.${pad(index + 1)}`,
    targetRole: role.targetRole,
    interviewType: 'TECHNICAL',
    phase: 'SCENARIO',
    skillCanonical: skillDef.canonical,
    focusType: 'depth_probe',
    seniority: null,
    difficulty: 3,
    questionVi: `Giả sử một thay đổi liên quan đến ${skillDef.vi} vừa lên production và có dấu hiệu không ổn định. Bạn sẽ xử lý trong 30 phút đầu như thế nào?`,
    questionEn: `Suppose a change involving ${skillDef.en} has just reached production and looks unstable. What would you do in the first 30 minutes?`,
    expectedSignals: ['triage', skillDef.signal, 'risk_control'],
    rubricDimensions: [...BASE_DIMS, 'problem_solving'],
    sourceBasis: `Scenario authored from ${role.roleEn} task patterns and SkillBridge problem-solving rubric.`,
    priority: 700 - index,
  }));
}

function buildBehavioralQuestions(role: RoleDefinition): LogicalQuestion[] {
  const prompts: Array<{ vi: string; en: string; signals: string[] }> = [
    {
      vi: `Kể về một lần bạn nhận ownership cho một vấn đề kỹ thuật khó trong vai trò ${role.roleVi}. Bạn đã làm gì?`,
      en: `Tell me about a time you took ownership of a difficult technical problem in a ${role.roleEn}-type role. What did you do?`,
      signals: ['ownership', 'action', 'result'],
    },
    {
      vi: `Kể về một lần bạn bất đồng kỹ thuật với đồng đội. Bạn trình bày quan điểm và đi đến quyết định thế nào?`,
      en: `Tell me about a time you disagreed with a teammate on a technical decision. How did you explain your view and reach a decision?`,
      signals: ['conflict_resolution', 'communication', 'tradeoff'],
    },
    {
      vi: `Kể về một lần bạn phát hiện lỗi muộn hoặc sau khi release. Bạn xử lý và học được gì?`,
      en: `Tell me about a time you found a bug late or after release. How did you handle it and what did you learn?`,
      signals: ['accountability', 'incident_learning', 'improvement'],
    },
    {
      vi: `Khi yêu cầu mơ hồ, bạn đã làm gì để tránh làm sai hướng? Hãy trả lời theo STAR.`,
      en: `When requirements were ambiguous, what did you do to avoid building the wrong thing? Please answer using STAR.`,
      signals: ['clarification', 'star_structure', 'communication'],
    },
    {
      vi: `Kể về một lần bạn phải cân bằng tốc độ giao hàng và chất lượng kỹ thuật. Bạn chọn trade-off ra sao?`,
      en: `Tell me about a time you balanced delivery speed and technical quality. What trade-off did you choose?`,
      signals: ['prioritization', 'tradeoff', 'impact'],
    },
    {
      vi: `Bạn từng nhận feedback kỹ thuật khó nghe chưa? Bạn phản hồi và thay đổi cách làm thế nào?`,
      en: `Have you received difficult technical feedback? How did you respond and change your approach?`,
      signals: ['feedback', 'learning', 'self_awareness'],
    },
    {
      vi: `Kể về một lần bạn giúp người khác hiểu một vấn đề kỹ thuật phức tạp. Bạn diễn đạt thế nào?`,
      en: `Tell me about a time you helped someone understand a complex technical issue. How did you explain it?`,
      signals: ['communication', 'simplification', 'collaboration'],
    },
    {
      vi: `Khi không chắc câu trả lời hoặc giải pháp của mình đúng, bạn thường kiểm chứng bằng cách nào?`,
      en: `When you are not sure your answer or solution is correct, how do you validate it?`,
      signals: ['calibrated_confidence', 'validation', 'honesty'],
    },
    {
      vi: `Kể về một lần bạn phải học nhanh một công nghệ hoặc domain mới để hoàn thành task. Bạn học theo cách nào?`,
      en: `Tell me about a time you had to quickly learn a new technology or domain to finish a task. How did you learn it?`,
      signals: ['learning_strategy', 'adaptability', 'result'],
    },
    {
      vi: `Nếu trong phỏng vấn bạn chưa biết một khái niệm, bạn sẽ trao đổi với interviewer thế nào để vẫn thể hiện được năng lực?`,
      en: `If you do not know a concept in an interview, how would you communicate with the interviewer while still showing your ability?`,
      signals: ['honesty', 'calibrated_confidence', 'problem_solving'],
    },
  ];

  return prompts.map((prompt, index) => ({
    questionKey: `${role.targetRole}.behavioral.${pad(index + 1)}`,
    targetRole: role.targetRole,
    interviewType: 'TECHNICAL',
    phase: 'BEHAVIORAL',
    skillCanonical: null,
    focusType: null,
    seniority: null,
    difficulty: 2,
    questionVi: prompt.vi,
    questionEn: prompt.en,
    expectedSignals: prompt.signals,
    rubricDimensions: [...BASE_DIMS, 'role_fit'],
    sourceBasis: `SkillBridge behavioral rubric for ${role.roleEn}; question wording authored internally.`,
    priority: 600 - index,
  }));
}

function toLanguageRows(question: LogicalQuestion): InterviewQuestionBankSeed[] {
  return [toSeed(question, 'vi', question.questionVi), toSeed(question, 'en', question.questionEn)];
}

function toSeed(
  question: LogicalQuestion,
  language: QuestionBankLanguage,
  questionText: string,
): InterviewQuestionBankSeed {
  return {
    questionKey: question.questionKey,
    language,
    targetRole: question.targetRole,
    interviewType: question.interviewType,
    phase: question.phase,
    skillCanonical: question.skillCanonical,
    focusType: question.focusType,
    seniority: question.seniority,
    difficulty: question.difficulty,
    questionText,
    expectedSignals: question.expectedSignals,
    rubricDimensions: question.rubricDimensions,
    sourceKind: 'authored_from_taxonomy',
    sourceUrl: SOURCE_URL,
    sourceBasis: question.sourceBasis,
    license: SOURCE_LICENSE,
    attribution: ATTRIBUTION,
    reviewStatus: 'draft',
    priority: question.priority,
    active: true,
  };
}

function skill(canonical: string, vi: string, en: string, signal: string): SkillDefinition {
  return { canonical, vi, en, signal };
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

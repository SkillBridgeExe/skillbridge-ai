import { classifyRole } from '../../../../src/modules/jobs/ingest/ingest-normalizers';

describe('classifyRole — ai_app_engineer routing', () => {
  const aiApp = [
    'LLM Engineer',
    'LLM Developer',
    'RAG Engineer',
    'RAG Developer',
    'GenAI Engineer',
    'Generative AI Developer',
    'Applied AI Engineer',
    'AI Application Engineer',
    'AI Application Developer',
    'Prompt Engineer',
  ];
  it.each(aiApp)('%s → ai_app_engineer', (title) => {
    expect(classifyRole(title)).toBe('ai_app_engineer');
  });

  const aiMl = [
    'Machine Learning Engineer',
    'Data Scientist',
    'NLP Engineer',
    'Computer Vision Engineer',
    'Mobile AI Engineer',
    'On-device ML Engineer',
  ];
  it.each(aiMl)('%s → ai_ml_engineer (unchanged)', (title) => {
    expect(classifyRole(title)).toBe('ai_ml_engineer');
  });

  it('generic "AI Engineer" is NOT ai_app_engineer (stays ai_ml_engineer)', () => {
    expect(classifyRole('AI Engineer')).not.toBe('ai_app_engineer');
    expect(classifyRole('AI Engineer')).toBe('ai_ml_engineer');
  });

  it('no drift on non-AI roles', () => {
    expect(classifyRole('Frontend Developer')).toBe('frontend_developer');
    expect(classifyRole('Backend Developer')).toBe('backend_developer');
    expect(classifyRole('Fullstack Developer')).toBe('fullstack_developer');
    expect(classifyRole('DevOps Engineer')).toBe('devops_engineer');
    expect(classifyRole('QA Tester')).toBe('qa_tester');
    expect(classifyRole('Data Analyst')).toBe('data_analyst');
  });
});

describe('classifyRole — AI-app precision: a GenAI skill-mention must NOT override a non-AI-app primary role', () => {
  // Real titles from the live pool (skill-laden): "GenAI"/"Gen AI" appears as a SKILL, not the role head.
  it('"Senior Data Scientist AI, GenAI, Machine Learning" → ai_ml_engineer (not ai_app)', () => {
    expect(classifyRole('Senior Data Scientist AI, GenAI, Machine Learning')).toBe('ai_ml_engineer');
  });
  it('"Lead QC Engineer Automation Gen AI" → NOT ai_app_engineer', () => {
    expect(classifyRole('Lead QC Engineer Automation Gen AI')).not.toBe('ai_app_engineer');
  });
  it('"Senior Software Engineer Android, Kotlin, Gen AI" → NOT ai_app_engineer', () => {
    expect(classifyRole('Senior Software Engineer Android, Kotlin, Gen AI')).not.toBe(
      'ai_app_engineer',
    );
  });

  // Genuine AI-app titles must STILL classify as ai_app_engineer after the precision fix:
  it('"GenAI Engineer" → ai_app_engineer (head role, kept)', () => {
    expect(classifyRole('GenAI Engineer')).toBe('ai_app_engineer');
  });
  it('"Senior Generative AI NLP, LLM" → ai_app_engineer (Generative AI head, kept)', () => {
    expect(classifyRole('Senior Generative AI NLP, LLM')).toBe('ai_app_engineer');
  });
  it('"Senior AI Developer Generative AI, Python, FastAPI" → ai_app_engineer (kept)', () => {
    expect(classifyRole('Senior AI Developer Generative AI, Python, FastAPI')).toBe(
      'ai_app_engineer',
    );
  });
});

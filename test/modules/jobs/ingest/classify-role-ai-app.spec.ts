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

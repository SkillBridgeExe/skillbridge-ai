import { InterviewService } from '../../../src/modules/interview/interview.service';

describe('InterviewService.end', () => {
  const parsedJson = {
    overall_score: 82,
    semantic_score: 80,
    llm_score: 84,
    communication_score: 78,
    ai_feedback: {
      summary: 'Solid.',
      technical_delivery: {
        concept_accuracy: 80,
        problem_solving: 80,
        system_thinking: 70,
        code_quality: 75,
      },
      communication_flow: {
        articulation: 80,
        listening_response: 80,
        filler_words: 90,
        structured_answers: 75,
      },
      body_language: null,
      recommendations: 'Practice evidence.',
      suggested_modules: [],
    },
    per_question_scores: [
      {
        question_order: 1,
        question: 'Where should I call 0987 654 321?',
        answer: 'Email me at candidate@example.com or call 0987 654 321.',
        ai_score: 70,
        strengths: [],
        improvements: [],
        time_taken_seconds: 20,
      },
    ],
    interview_gap_items: [
      {
        target_type: 'evidence',
        skill_canonical: 'react',
        display_name: 'React',
        weakness_type: 'evidence_gap',
        severity: 0.7,
        evidence_from_answer: 'Candidate gave candidate@example.com and 0987 654 321.',
        recommended_action: 'Add concrete project evidence.',
        linked_question_id: '1',
      },
    ],
  };

  function build() {
    const llm = {
      complete: jest.fn().mockResolvedValue({
        rawResponse: { text: 'candidate@example.com 0987 654 321' },
        parsedJson,
        tokenUsage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        estimatedCostUsd: 0.001,
        latencyMs: 50,
      }),
    };
    const prompts = {
      get: jest.fn().mockReturnValue({
        code: 'interview_scoring',
        version: 1,
        meta: { system: 'score system' },
      }),
      render: jest.fn((_code: string, vars: Record<string, unknown>) => JSON.stringify(vars)),
    };
    const tracing = {
      startAiRequest: jest.fn().mockResolvedValue('ai-request-1'),
      saveAiResult: jest.fn().mockResolvedValue('ai-result-1'),
      completeAiRequest: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };
    return {
      service: new InterviewService(llm as never, prompts as never, tracing as never),
      llm,
      prompts,
      tracing,
    };
  }

  it('uses schema-enforced JSON and masks interview transcript PII before render and trace persistence', async () => {
    const { service, llm, prompts, tracing } = build();

    await service.end('user-1', {
      session_id: '48ed4496-c0c9-4b9e-8fe9-eebea5435693',
      all_questions_answers: [
        {
          order: 1,
          question: 'Where should I call 0987 654 321?',
          answer: 'Email me at candidate@example.com or call 0987 654 321.',
        },
      ],
      duration_seconds: 90,
      scoring_template_code: 'interview_scoring_v1',
      probed_skills: 'react',
    });

    const renderedVars = prompts.render.mock.calls[0][1] as {
      questions: Array<{ question: string; answer: string }>;
    };
    expect(JSON.stringify(renderedVars.questions)).not.toContain('candidate@example.com');
    expect(JSON.stringify(renderedVars.questions)).not.toContain('0987');
    expect(JSON.stringify(renderedVars.questions)).toContain('[redacted-email]');
    expect(JSON.stringify(renderedVars.questions)).toContain('[redacted-phone]');

    expect(llm.complete.mock.calls[0][1]).toMatchObject({
      jsonMode: true,
      responseSchema: expect.objectContaining({ type: 'object' }),
    });

    const saved = tracing.saveAiResult.mock.calls[0][0];
    expect(JSON.stringify(saved.rawResponse)).not.toContain('candidate@example.com');
    expect(JSON.stringify(saved.rawResponse)).not.toContain('0987');
    expect(JSON.stringify(saved.parsedResponse)).not.toContain('candidate@example.com');
    expect(JSON.stringify(saved.parsedResponse)).not.toContain('0987');
  });
});

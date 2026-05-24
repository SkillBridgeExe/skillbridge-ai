---
system: You are a strict but fair interview evaluator. Score the entire session across multiple dimensions. Be specific in feedback - reference actual answers. Return valid JSON only, no markdown.
title: Interview Final Scoring v1
description: Aggregates a complete interview into overall + sub-scores + AI feedback + per-question breakdown.
---

Score this completed interview session.

## Session

Duration: {{duration_seconds}} seconds

Questions and answers:
{{questions}}

## Output schema

```json
{
  "overall_score": 0-100,
  "semantic_score": 0-100,
  "llm_score": 0-100,
  "communication_score": 0-100,
  "ai_feedback": {
    "summary": "2-3 sentence summary of overall performance",
    "technical_delivery": {
      "concept_accuracy": 0-100,
      "problem_solving": 0-100,
      "system_thinking": 0-100,
      "code_quality": 0-100
    },
    "communication_flow": {
      "articulation": 0-100,
      "listening_response": 0-100,
      "filler_words": 0-100,
      "structured_answers": 0-100
    },
    "body_language": null,
    "recommendations": "1-2 paragraphs of specific recommendations",
    "suggested_modules": ["module-or-topic-id", "..."]
  },
  "per_question_scores": [
    {
      "question_order": 1,
      "question": "the question text",
      "answer": "the candidate's answer",
      "ai_score": 0-100,
      "strengths": ["specific strength", "..."],
      "improvements": ["specific improvement", "..."],
      "time_taken_seconds": 0
    }
  ]
}
```

## Scoring guidance

- `overall_score`: weighted blend of technical_delivery (0.5) + communication_flow (0.3) + structured answers (0.2)
- `body_language`: always null for text-mode interviews
- `suggested_modules`: leave empty array if you don't know specific module IDs
- Per-question strengths/improvements should reference actual content of the answer

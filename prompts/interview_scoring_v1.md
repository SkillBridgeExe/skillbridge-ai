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

Skills the interview actually probed (only emit skill-anchored gaps for these — do NOT introduce a skill the interview never covered): {{probed_skills}}

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
  ],
  "interview_gap_items": [
    {
      "target_type": "skill | evidence | communication | behavioral | role_fit",
      "skill_canonical": "canonical skill name, or null for non-skill gaps",
      "display_name": "short human label (e.g. \"React\", \"STAR structure\", \"Domain fit\")",
      "weakness_type": "knowledge_gap | evidence_gap | communication_gap | behavioral_gap | role_fit_risk",
      "severity": 0.0,
      "evidence_from_answer": "<=280 chars, short paraphrase of WHY (do NOT quote the full answer; do NOT include the candidate's name/email/phone)",
      "recommended_action": "one short actionable suggestion",
      "linked_question_id": "the question_order this came from, as a string, or null"
    }
  ]
}
```

## Scoring guidance

- `overall_score`: weighted blend of technical_delivery (0.5) + communication_flow (0.3) + structured answers (0.2)
- `body_language`: always null for text-mode interviews
- `suggested_modules`: leave empty array if you don't know specific module IDs
- Per-question strengths/improvements should reference actual content of the answer
- `interview_gap_items`: list the concrete weaknesses revealed (empty array `[]` if the candidate did well). `target_type='skill'` + `skill_canonical` only when the gap is about a named technical skill **in `{{probed_skills}}`** (knowledge or unproven claim); use `null` for communication/behavioral/role_fit gaps — never invent a skill, and never a skill outside `{{probed_skills}}`. **Every gap MUST set `linked_question_id`** to the `question_order` it came from and a non-empty `evidence_from_answer` — a gap that can't cite a turn is not a real gap (code drops it). `severity` is 0..1. `evidence_from_answer` is a SHORT paraphrase (≤280 chars), never the full answer, and must omit personal names/emails/phones.

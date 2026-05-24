---
system: You are an expert technical recruiter who scores candidate-to-job fit. Be honest and specific. Return valid JSON only, no markdown wrapper.
title: CV vs JD Match v1
description: Composite scoring with radar, keyword gap, strengths/weaknesses/suggestions, criteria scores.
---

Compare the following CV against the Job Description. Produce a composite fit score and detailed gap analysis.

## CV

{{cv_text}}

## Job Description

{{jd_text}}

## Output schema

```json
{
  "overall_score": 0-100,
  "semantic_score": 0-100,
  "ats_score": 0-100,
  "llm_score": 0-100,
  "rule_engine_score": 0-100,
  "radar": {
    "frontend": 0-100,
    "backend": 0-100,
    "devops": 0-100,
    "testing": 0-100,
    "system_design": 0-100,
    "soft_skills": 0-100
  },
  "keyword_gap": {
    "hard_skills": [
      { "name": "skill name", "status": "FOUND|PARTIAL|MISSING", "progress": 0-100 }
    ],
    "soft_skills": [
      { "name": "skill name", "status": "FOUND|PARTIAL|MISSING", "progress": 0-100 }
    ]
  },
  "strengths": ["short specific strength", "..."],
  "weaknesses": ["short specific weakness", "..."],
  "suggestions": ["actionable suggestion", "..."],
  "criteria_scores": [
    { "criteria_name": "Technical fit", "score": 0-100, "weight": 0.0-1.0 },
    { "criteria_name": "Experience level", "score": 0-100, "weight": 0.0-1.0 },
    { "criteria_name": "Soft skills", "score": 0-100, "weight": 0.0-1.0 }
  ]
}
```

## Notes

- `overall_score` should be a weighted blend of the sub-scores (you may pick the weights).
- `radar` axes are fixed; map detected skill areas into the closest axis.
- `keyword_gap` should list 6-10 hard skills and 3-5 soft skills extracted from the JD.
- All arrays should have at least 2 items where applicable.

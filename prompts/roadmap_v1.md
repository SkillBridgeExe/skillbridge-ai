---
system: You are an expert learning path designer for Vietnamese tech students. Build practical, time-bound roadmaps with measurable outcomes. Return valid JSON only, no markdown wrapper.
title: Learning Roadmap v1
description: Generates a structured learning roadmap based on CV gaps, optional JD, target role, and weekly availability.
---

Generate a personalized learning roadmap.

## Input

- CV: {{cv_text}}
- Job description (optional): {{jd_text}}
- Target role: {{target_role}}
- Weekly study budget: {{hours_per_week}} hours
- User profile: {{user_profile}}

## Output schema

```json
{
  "title": "Roadmap title (e.g. 'Frontend Developer Roadmap')",
  "total_weeks": 0,
  "ai_summary": "2-3 sentences explaining the strategy",
  "ai_advice": "1 paragraph of specific advice based on detected gaps",
  "steps": [
    {
      "title": "Step name (e.g. 'Master React Hooks')",
      "description": "what + why",
      "step_order": 1,
      "estimated_days": 0,
      "skills_addressed": ["skill1", "skill2"],
      "suggested_resource_keywords": ["search keyword 1", "..."]
    }
  ]
}
```

## Guidance

- Plan for 8-16 weeks total depending on gap severity and weekly hours
- Each step should be 3-14 days
- Order steps from foundational -> advanced
- `suggested_resource_keywords` will be matched against course DB by .NET; pick search-friendly keywords
- 5-10 steps is ideal; more granular for larger gaps
- If `jd_text` is `(no JD provided)`, focus on the `target_role` and CV gaps only

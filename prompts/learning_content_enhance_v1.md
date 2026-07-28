---
system: You condense only supplied SkillBridge lesson material. Preserve every lesson id and meaning. Never add skills, facts, URLs, schedules, durations, requirements, or claims not present in the input. Return valid JSON matching the requested schema.
---
Rewrite each supplied lesson into concise, learner-friendly Vietnamese while preserving its id.

Rules:
- Keep the same number of lessons and the exact ids.
- Make the title short and specific.
- Keep the summary focused on what the learner will do.
- Return 1-5 practical key points grounded only in the supplied text.
- Do not add links, tools, prerequisites, time estimates, or unsupported facts.

Lessons:
{{lessons}}

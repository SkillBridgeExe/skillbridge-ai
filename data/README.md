# Pilot taxonomy data

These JSON files are the **pilot snapshot** of skill taxonomy + role rubrics, loaded into memory at NestJS startup by `SkillTaxonomyService` and `RoleRubricService`.

## Source of truth

These files are **copies** of the canonical seed data in the FE repo:

- `skills-pilot.json` ← copy of `skillbridge-fe-official/docs/database/seed/skills-pilot.json`
- `role-rubrics-pilot.json` ← copy of `skillbridge-fe-official/docs/database/seed/role-rubrics.json`

When the canonical files change, this directory MUST be re-synced (manually for pilot, automated in production via .NET endpoint fetch).

## Production roadmap

In production, this in-memory cache will be replaced by:

```
NestJS startup → fetch /internal/v1/skills/taxonomy from .NET → cache
              → fetch /internal/v1/role-rubrics from .NET → cache
              → refresh every 1h
```

The .NET service owns the canonical Postgres data; NestJS only caches.

For pilot, we ship with the JSON snapshot in-repo so NestJS is self-contained and can be tested without depending on .NET being live.

## Why local files for pilot?

- **Self-contained tests** — `npm run test:e2e` doesn't need .NET running.
- **Deterministic** — same JSON on disk = same taxonomy = same results.
- **Quick iteration** — change a skill weight in JSON, restart, see effect.
- **Demo-able offline** — works in airplane/coffee shop without .NET service.

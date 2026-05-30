# Pilot taxonomy data

These JSON files are the **pilot snapshot** of skill taxonomy + role rubrics, loaded into memory at NestJS startup by `SkillTaxonomyService` and `RoleRubricService`.

## Source of truth

These files are **copies** of the canonical seed data in the FE repo:

- `skills-pilot.json` ← copy of `skillbridge-fe-official/docs/database/seed/skills-pilot.json`
- `role-rubrics-pilot.json` ← copy of `skillbridge-fe-official/docs/database/seed/role-rubrics.json`

When the canonical files change, this directory MUST be re-synced (manually for pilot; in production, seed straight from these snapshots via a TypeORM migration/seeder).

## Production roadmap

After the 2026-05-30 NestJS pivot, **NestJS owns the canonical Postgres data via TypeORM** (no .NET fetch). In production:

```
JSON snapshot (here) → TypeORM seeder/migration → skills / role_skill_requirements tables
SkillTaxonomyService / RoleRubricService → load from DB (+ in-memory cache)
```

For pilot, we ship the JSON snapshot in-repo so NestJS is self-contained and can be tested without a live DB.

## Why local files for pilot?

- **Self-contained tests** — `npm run test:e2e` doesn't need a live DB.
- **Deterministic** — same JSON on disk = same taxonomy = same results.
- **Quick iteration** — change a skill weight in JSON, restart, see effect.
- **Demo-able offline** — works in airplane/coffee shop without a live DB.

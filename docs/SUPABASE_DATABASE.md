# Supabase Database Setup

SkillBridge uses Supabase as a PostgreSQL host only. Authentication, sessions, roles, quota,
ownership checks, and protected routes stay in this NestJS backend.

## What stays unchanged

- Frontend calls the NestJS public API under `/api/*`.
- Users register and log in through `/api/auth/register`, `/api/auth/login`, `/api/auth/google`,
  `/api/auth/refresh`, and `/api/auth/logout`.
- Protected routes continue to use the backend-issued JWT with `AuthGuard('jwt')`.
- The local `users`, `accounts`, `sessions`, `roles`, and `user_roles` tables remain the platform
  source of truth for app authorization.

## Supabase project setup

1. Create or open a Supabase project.
2. Copy the pooled or direct PostgreSQL connection string from the Supabase dashboard.
3. Put it in `.env` as `DATABASE_URL`.
4. Set `DB_SSL=true` for Supabase hosted Postgres.
5. Keep `TYPEORM_SYNCHRONIZE=false`.
6. Run migrations from this repo.

```powershell
pnpm.cmd migration:run
```

For local development without Supabase, keep using a local Postgres URL and `DB_SSL=false`.

## Important auth boundary

Do not expose Supabase secret keys or service-role keys to the frontend. The frontend should not
query app tables directly through the Supabase Data API unless a later architecture change adds
explicit Row Level Security policies for that path.

If Supabase Auth is added later, design it as a separate migration. Do not mix Supabase Auth tokens
into the current route guards without preserving local ownership, quota, and role checks.

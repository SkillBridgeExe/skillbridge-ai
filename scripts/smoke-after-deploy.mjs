#!/usr/bin/env node
// Post-deploy smoke test for skillbridge-ai. Run AFTER a deploy (in CD or by hand) to
// confirm the LIVE service actually serves requests — not just that the process booted.
// It catches the failure classes the shallow `/health` probe misses: DB down, migrations
// not applied (a missing migration → 500 on real routes), auth / JWT misconfig, broken
// routing. (Strict-schema 400s are caught earlier, pre-deploy, by
// src/infrastructure/llm/strict-schema.spec.ts.)
//
// Usage:
//   SMOKE_BASE_URL=https://<cloud-run-url> \
//   [SMOKE_EMAIL=smoke@example.com SMOKE_PASSWORD=...] \
//   node scripts/smoke-after-deploy.mjs
//
// Exit 0 = all checks passed. Exit 1 = a check failed (fail the deploy / fire an alert).
// Exit 2 = misconfigured (no SMOKE_BASE_URL).
//
// Requires Node 18+ (global fetch, top-level await). No dependencies.

const BASE = process.env.SMOKE_BASE_URL?.replace(/\/$/, '');
const EMAIL = process.env.SMOKE_EMAIL;
const PASSWORD = process.env.SMOKE_PASSWORD;
const TIMEOUT_MS = 15000;

if (!BASE) {
  console.error('SMOKE_BASE_URL is required (e.g. https://skillbridge-ai-xxxx.run.app)');
  process.exit(2);
}

let failures = 0;

async function http(method, path, { token, body } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON body */
    }
    return { status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function check(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failures++;
    console.error(`  FAIL  ${name} — ${e.message}`);
  }
}

console.log(`Smoke testing ${BASE}`);

// 1. Liveness — the process is up and routing works.
await check('GET /health -> 200 {status:"ok"}', async () => {
  const r = await http('GET', '/health');
  assert(r.status === 200, `expected 200, got ${r.status}`);
  assert(r.json?.status === 'ok', `expected status:"ok", got ${r.text?.slice(0, 80)}`);
});

// 2 + 3. Auth + DB + migrations — login queries the DB, so a DB outage or a missing
// migration fails here (not silently). Then prove the issued JWT actually authorizes.
if (EMAIL && PASSWORD) {
  let token = null;
  await check('POST /api/auth/login -> 2xx + accessToken', async () => {
    const r = await http('POST', '/api/auth/login', { body: { email: EMAIL, password: PASSWORD } });
    assert(r.status >= 200 && r.status < 300, `expected 2xx, got ${r.status}: ${r.text?.slice(0, 120)}`);
    assert(
      typeof r.json?.accessToken === 'string' && r.json.accessToken.length > 0,
      'no accessToken in login response',
    );
    token = r.json.accessToken;
  });
  if (token) {
    await check('GET /api/auth/me (authed) -> 2xx', async () => {
      const r = await http('GET', '/api/auth/me', { token });
      assert(r.status >= 200 && r.status < 300, `expected 2xx, got ${r.status}: ${r.text?.slice(0, 120)}`);
    });
  }
} else {
  console.log('  SKIP  authed checks (set SMOKE_EMAIL + SMOKE_PASSWORD to enable the DB/auth tier)');
}

console.log(failures === 0 ? '\nSmoke OK' : `\nSmoke FAILED (${failures} check(s) failed)`);
process.exit(failures === 0 ? 0 : 1);

# Admin PayOS Revenue Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Each task is independently verifiable and uses checkbox tracking.

**Goal:** Make the Admin Overview revenue metric comparable to the PayOS calendar-period view by resolving ICT calendar windows, exposing paid-order counts, recording provider payment time, and adding an explicit, idempotent Admin reconciliation action for local pending orders.

**Architecture:** Keep `.NET`/NestJS ownership boundaries unchanged. The NestJS billing module owns PayOS reconciliation and settlement; the NestJS users module owns the Admin summary query. The summary reads the local, verified payment-order ledger only. The Admin UI requests a calendar window and explicitly triggers reconciliation before invalidating the summary query. AGY implements the frontend in `D:\Ky7-FPT\EXE101\SkillBridge\.worktrees\admin-payos-revenue-reconciliation-fe`; backend work happens in `D:\Ky7-FPT\EXE101\SkillBridge\skillbridge-ai\.worktrees\admin-payos-revenue-reconciliation`.

**Tech Stack:** NestJS, TypeScript, TypeORM, PostgreSQL, Jest/ts-jest, class-validator/class-transformer, PayOS provider adapter, React/Vite/TanStack Query on the frontend.

## Global constraints

- Branch name for both sides: `feature/admin-payos-revenue-reconciliation`.
- Preserve existing `rangeDays` behavior for callers that do not send the new `period` field.
- Use `Asia/Ho_Chi_Minh` for calendar boundaries; PostgreSQL predicates use UTC instants with an exclusive upper bound.
- Revenue is local verified gross charged revenue: active provider + `VND` + `PAID` + resolved `paidAt` window. It is not a PayOS account balance, payout, or fee-adjusted settlement amount.
- Never fabricate a missing local order from a PayOS dashboard total, and never delete a historical local `PAID` row because PayOS can no longer retrieve its payment link.
- Reconciliation must use the existing transactional `BillingSettlementService`; it must not grant a subscription or credits outside that path.
- Do not call PayOS during every summary render. Reconciliation is an explicit Admin action and must tolerate partial provider failures.
- Keep production changes limited to code and tests. Do not run write queries against the production database during verification.

## Backend implementation

### Task 1: Add a pure ICT revenue-window resolver

**Files:**

- Add `src/platform/users/admin-revenue-window.ts`.
- Add `src/platform/users/admin-revenue-window.spec.ts`.
- Modify `src/platform/users/dto/admin-users.dto.ts`.

**Red/green steps:**

- [ ] Write tests for `TODAY`, `YESTERDAY`, `THIS_WEEK`, `THIS_MONTH`, `LAST_MONTH`, `THIS_YEAR`, and `LAST_YEAR` around a fixed UTC instant, asserting ICT midnight boundaries and UTC conversion.
- [ ] Write tests for `CUSTOM` inclusive `from`/`to` dates, where `to` becomes the next ICT midnight as an exclusive boundary.
- [ ] Write tests rejecting malformed dates, inverted dates, a missing custom endpoint, and a custom window longer than the allowed safety limit if the DTO imposes one.
- [ ] Write a compatibility test proving an omitted `period` resolves to `ROLLING_DAYS` using the current `rangeDays` default and current time as the upper bound.
- [ ] Implement a small dependency-free resolver. Vietnam has no DST, so use explicit UTC+07 conversion rather than introducing a date library.
- [ ] Export the resolved shape `{ period, from, to, timezone }` and a reusable SQL-window type.

**Contract:**

```ts
type AdminRevenuePeriod =
  | 'TODAY'
  | 'YESTERDAY'
  | 'THIS_WEEK'
  | 'THIS_MONTH'
  | 'LAST_MONTH'
  | 'THIS_YEAR'
  | 'LAST_YEAR'
  | 'CUSTOM';

type AdminRevenueWindowQuery = {
  period?: AdminRevenuePeriod;
  from?: string; // YYYY-MM-DD, inclusive, ICT
  to?: string;   // YYYY-MM-DD, inclusive, ICT
  rangeDays?: number; // legacy callers only
};

type ResolvedAdminRevenueWindow = {
  period: AdminRevenuePeriod | 'ROLLING_DAYS';
  from: Date;
  to: Date; // exclusive
  fromDate: string; // ICT YYYY-MM-DD for response/debugging
  toDate: string;   // inclusive ICT YYYY-MM-DD for response/debugging
  timezone: 'Asia/Ho_Chi_Minh';
};
```

The implementation should make the current time injectable as a `now` argument so unit tests do not depend on the wall clock. DTO validation should reject `CUSTOM` without both dates; the resolver remains the final source of truth for calendar validity.

### Task 2: Extend the Admin summary DTO and ledger query

**Files:**

- Modify `src/platform/users/dto/admin-users.dto.ts`.
- Modify `src/platform/users/admin-users.service.ts`.
- Add/update `src/platform/users/admin-users.service.spec.ts` (or the nearest existing Admin users service test file).
- Modify `src/platform/users/admin-users.controller.ts` only if the existing method does not already pass the DTO through unchanged.

**Red/green steps:**

- [ ] Add DTO tests for valid preset values and custom query validation.
- [ ] Add summary-service tests proving the payment query includes `status = 'PAID'`, `provider = active provider`, `currency = 'VND'`, `paidAt >= from`, and `paidAt < to`.
- [ ] Add tests proving `paidRevenueVnd` sums only matching rows and `paidOrderCount` counts the same matching rows.
- [ ] Add a test asserting `window.period`, ICT date metadata, and timezone are returned.
- [ ] Add a compatibility test for an omitted `period`: existing `rangeDays` and the existing non-revenue totals remain available.
- [ ] Inject `ConfigService` into `AdminUsersService` and resolve the active provider with `PAYMENT_PROVIDER ?? 'PAYOS'`; do not import `BillingModule` into `UsersModule`, avoiding a module cycle.
- [ ] Replace the payment `find` filter with a QueryBuilder (or equivalent explicit predicates) so both lower and exclusive upper paid-time boundaries, provider, and currency are enforced.
- [ ] Keep registration/activity queries on the existing lower-bound behavior unless they are explicitly part of the new revenue contract; only the payment metric changes to the resolved calendar window.
- [ ] Add `paidOrderCount` without removing or renaming any existing totals.

Expected summary additions:

```json
{
  "totals": {
    "paidRevenueVnd": 4417800,
    "paidOrderCount": 25
  },
  "window": {
    "period": "THIS_YEAR",
    "from": "2026-01-01",
    "to": "2026-12-31",
    "timezone": "Asia/Ho_Chi_Minh"
  }
}
```

`paidRevenueVnd` in this example is illustrative; the backend must return the actual local ledger value after reconciliation.

### Task 3: Preserve provider transaction time

**Files:**

- Modify `src/platform/billing/payment-providers/payment-provider.port.ts`.
- Modify `src/platform/billing/payment-providers/payos-payment.provider.ts`.
- Modify `src/platform/billing/services/billing-settlement.service.ts`.
- Update `src/platform/billing/payment-providers/payos-payment.provider.spec.ts` and `src/platform/billing/services/billing-settlement.service.spec.ts`.

**Red/green steps:**

- [ ] Add an optional `paidAt: Date | null` field to `VerifiedPaymentWebhook`/`PaymentStatusSnapshot`.
- [ ] Add adapter tests mapping PayOS webhook `transactionDateTime` to a valid `Date` and returning `null` for missing/invalid values.
- [ ] Add adapter tests mapping the first successful status transaction’s `transactionDateTime` to `paidAt`; do not treat a non-successful transaction as paid time.
- [ ] Update all existing provider test fixtures to include or tolerate the optional field.
- [ ] Add a settlement test asserting `payment.paidAt` is saved exactly when valid.
- [ ] Implement settlement fallback as `payment.paidAt ?? new Date()` only when the provider omitted the timestamp.
- [ ] Keep amount, currency, payment-link, voucher, subscription, credit, and mentor settlement checks unchanged.

### Task 4: Extract shared pending-order reconciliation logic

**Files:**

- Add `src/platform/billing/services/payment-order-reconciliation.service.ts`.
- Add `src/platform/billing/services/payment-order-reconciliation.service.spec.ts`.
- Modify `src/platform/billing/billing.service.ts` and `src/platform/billing/billing.service.spec.ts`.
- Modify `src/platform/billing/billing.module.ts`.

**Red/green steps:**

- [ ] Write tests for a pending order whose provider snapshot is `PAID`: the provider is called once and settlement receives the verified snapshot.
- [ ] Write tests for terminal `CANCELLED`, `EXPIRED`, and `FAILED`: local status/payment-link are persisted and voucher reservation is released.
- [ ] Write tests for provider/network errors: the order remains `PENDING`, the error propagates to the caller, and no settlement occurs.
- [ ] Write tests for the existing 10-second provider-check claim/cooldown and a second concurrent attempt that does not call the provider.
- [ ] Implement the shared service with `reconcilePendingOrder(order)` plus a claim method that uses the existing atomic `lastProviderCheckAt` update.
- [ ] Refactor `BillingService.reconcileOrder` to keep user ownership/not-found checks and delegate the pending-order operation to the shared service. Preserve the existing user-facing response shape.
- [ ] Register the service in `BillingModule`.

The shared service must not turn a provider `PENDING` snapshot into a local terminal state. A provider failure must leave the order retryable.

### Task 5: Add Admin reconciliation endpoint

**Files:**

- Add `src/platform/billing/admin-payment-reconciliation.service.ts`.
- Add `src/platform/billing/admin-payment-reconciliation.service.spec.ts`.
- Modify `src/platform/billing/admin-billing.controller.ts`.
- Add or modify `src/platform/billing/dto/admin-billing.dto.ts`.
- Modify `src/platform/billing/billing.module.ts`.

**Red/green steps:**

- [ ] Add tests selecting only local `PENDING` orders for the active provider, `VND`, and an order lifetime intersecting the resolved window.
- [ ] Add tests for bounded concurrency (limit four) so a large pending set does not fan out unbounded PayOS requests.
- [ ] Add tests for settled, terminal, still-pending, and failed results and their aggregate counts.
- [ ] Add tests showing one provider failure does not prevent other orders from reconciling.
- [ ] Add an idempotence test: a repeat run does not call settlement for an already `PAID` order and does not duplicate entitlements/credits.
- [ ] Implement `POST /api/admin/billing/orders/reconcile` behind the existing JWT + `RolesGuard` + `ADMIN` guard.
- [ ] Resolve the active provider through `PaymentProviderRegistry` and use its code for the pending-order query.
- [ ] For each eligible pending order, call the shared reconciliation service; classify the result without throwing away per-order diagnostics.
- [ ] Return `{ window, provider, attempted, settled, terminal, pending, failed, results }`, with safe error codes/messages but no provider secrets or raw credentials.
- [ ] Keep the endpoint explicit and admin-only; do not add a PayOS call to `GET /api/admin/users/summary`.

The pending-order lifetime predicate should include orders created before the window that were still active at the window start, and exclude orders created at/after the exclusive window end. Use `created_at < to AND (expires_at IS NULL OR expires_at >= from)` plus active-provider/status/currency predicates.

### Task 6: Backend verification and contract handoff

- [ ] Run focused Jest tests for Tasks 1–5.
- [ ] Run `npm.cmd run lint`, `npm.cmd run test`, and `npm.cmd run build` in the backend worktree.
- [ ] Inspect the diff and confirm no production DB writes were used for verification.
- [ ] Commit backend changes on `feature/admin-payos-revenue-reconciliation`.
- [ ] Give AGY the exact API contract below and the frontend worktree path.

Frontend handoff contract:

```txt
GET /api/admin/users/summary?period=THIS_YEAR
GET /api/admin/users/summary?period=THIS_MONTH
GET /api/admin/users/summary?period=CUSTOM&from=2026-08-01&to=2026-08-11
POST /api/admin/billing/orders/reconcile
{
  "period": "THIS_YEAR"
}
```

Summary response fields to consume:

```ts
type AdminSummary = ExistingAdminSummary & {
  totals: ExistingAdminSummary['totals'] & {
    paidRevenueVnd: number;
    paidOrderCount: number;
  };
  window: {
    period: AdminRevenuePeriod | 'ROLLING_DAYS';
    from: string;
    to: string;
    timezone: 'Asia/Ho_Chi_Minh';
  };
};
```

Reconciliation response fields to consume:

```ts
type AdminReconcileResponse = {
  provider: string;
  window: AdminSummary['window'];
  attempted: number;
  settled: number;
  terminal: number;
  pending: number;
  failed: number;
  results: Array<{
    orderCode: number;
    status: 'PAID' | 'CANCELLED' | 'EXPIRED' | 'FAILED' | 'PENDING' | 'FAILED_RECONCILIATION';
    message?: string;
  }>;
};
```

## Frontend implementation for AGY

**Worktree:** `D:\Ky7-FPT\EXE101\SkillBridge\.worktrees\admin-payos-revenue-reconciliation-fe`

### Task 7: Update Admin Overview period/filter and sync UX

**Files:**

- Modify `src/constants/api-routes.ts`.
- Modify `src/api/admin-users.ts`.
- Modify `src/services/admin-users.service.ts`.
- Modify `src/api/admin-billing.ts`.
- Modify `src/pages/admin/AdminOverview.tsx`.
- Modify `src/components/admin/AdminKpiCard.tsx` only if the existing `changeLabel` prop cannot render the order-count badge cleanly.
- Add `src/pages/admin/AdminOverview.spec.tsx` or the project’s established page-test location.

**Red/green steps:**

- [ ] Add API tests for `period`, `from`, and `to` query parameters.
- [ ] Add API tests for `POST /api/admin/billing/orders/reconcile`.
- [ ] Set Admin Overview’s default request to `period=THIS_YEAR`; do not translate it to `rangeDays=365`.
- [ ] Replace the 7/30/90/365 selector with PayOS-style labels: Hôm qua, Hôm nay, Tuần này, Tháng này, Tháng trước, Năm nay, Năm trước, Tùy chỉnh.
- [ ] Keep custom ICT dates explicit and send `from`/`to` as `YYYY-MM-DD`.
- [ ] Render `paidRevenueVnd` and a compact secondary badge using `paidOrderCount` (for example, `25 đơn hàng hoàn thành`).
- [ ] Add an explicit `Đồng bộ PayOS` action with loading, partial-failure, retry, and disabled states.
- [ ] On a successful or partial reconciliation response, invalidate/refetch the summary query; do not optimistically invent a new amount.
- [ ] Label the metric as local completed payments synced from PayOS, so operators do not confuse it with the PayOS account dashboard’s net settlement.
- [ ] Add tests for default period, period change, custom query, revenue formatting, count badge, and query invalidation after sync.

### Task 8: Frontend verification

- [ ] Run `npm.cmd run lint`.
- [ ] Run `npm.cmd run typecheck`.
- [ ] Run `npm.cmd run test`.
- [ ] Run `npm.cmd run build`.
- [ ] Manually verify the Admin Overview in the frontend worktree with `Năm nay` selected and confirm the network request uses `period=THIS_YEAR`.

## Final integration checklist

- [ ] Backend and frontend are both on `feature/admin-payos-revenue-reconciliation` in separate worktrees.
- [ ] Backend summary returns the same period metadata that the frontend displays.
- [ ] Reconciliation is admin-only, bounded, retryable, and idempotent.
- [ ] Existing user reconciliation and webhook settlement tests still pass.
- [ ] No existing Admin summary fields or route paths were removed.
- [ ] The final handoff reports exact verification commands and any known difference between the local verified ledger and the PayOS dashboard.

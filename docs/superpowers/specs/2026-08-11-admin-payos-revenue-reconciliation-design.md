# Admin PayOS Revenue Reconciliation Design

**Status:** Draft for review  
**Branch:** `feature/admin-payos-revenue-reconciliation`

## Problem

The Admin Overview card currently sums local `payment_orders` rows with
`status = 'PAID'` over a rolling `rangeDays` window. PayOS uses calendar
periods such as “Năm nay” and reports its completed-payment view separately.

Production evidence on 2026-08-11:

- Admin’s default rolling 30-day value: `4,248,650 VND`.
- Local calendar-year ledger: `28` paid orders and `4,288,650 VND`.
- PayOS dashboard calendar-year view: `25` completed orders and `4,417,800 VND`.

The difference is caused by two gaps: the Admin filter is not calendar-based,
and local `PENDING` orders are not reconciled with PayOS before the revenue is
reported. The local ledger must remain auditable; the application must not
invent a PayOS transaction that has no local order record.

## Goals

1. Make Admin revenue periods match PayOS calendar semantics using the
   `Asia/Ho_Chi_Minh` timezone.
2. Allow an admin to reconcile local pending PayOS orders and verify legacy
   local `PAID` rows before refreshing the revenue summary.
3. Record the provider transaction time when PayOS supplies it, so a payment
   is grouped by when it happened rather than when the webhook was processed.
4. Return both completed revenue and completed-order count so the Admin page can
   be compared with PayOS using the same two metrics.
5. Preserve the existing `rangeDays` request for existing Admin Insights callers
   while adding the new calendar-period contract.

## Non-goals

- Do not mutate or delete historical `PAID` orders merely because the current
  PayOS account cannot retrieve an old payment link.
- Do not claim that a local report is an account-wide PayOS balance or net
  settlement amount after fees.
- Do not add a second payment provider or change checkout behavior.
- Do not call PayOS on every dashboard render. Reconciliation is an explicit,
  rate-limited Admin action.

## Design

### 1. Calendar period contract

Extend the Admin summary query with:

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
};
```

Preset boundaries are calculated in `Asia/Ho_Chi_Minh` and converted to UTC
instants for PostgreSQL. `to` is treated as an inclusive calendar date and is
converted to the next ICT midnight as the exclusive SQL upper bound. `CUSTOM`
requires both dates and rejects an inverted or invalid window.

When `period` is omitted, the existing `rangeDays` behavior remains the
backward-compatible default. The response includes the resolved `period`,
`from`, and `to` values so the UI can show exactly what was queried.

### 2. PayOS reconciliation

Add an Admin-only endpoint under the existing billing controller:

```txt
POST /api/admin/billing/orders/reconcile
```

The endpoint receives the same calendar window contract. It:

1. Finds local `PENDING` orders and legacy local `PAID` orders for the active
   provider inside the requested window.
2. Calls the provider status API with bounded concurrency.
3. Sends verified `PAID` snapshots from pending orders through the existing transactional
   `BillingSettlementService`, preserving amount/currency/payment-link checks.
4. Stores a provider-verification result for legacy `PAID` rows without
   changing their payment status or granting entitlements again.
5. Persists terminal non-paid statuses as the existing billing flow already
   does.
6. Treats provider errors and rate limits as per-order failures so one bad order
   does not hide the summary. The response reports attempted, settled,
   terminal, failed, and still-pending counts plus verified/unverified legacy
   paid rows.

The reconciliation action is idempotent: an already `PAID` order is not settled
again, and repeated clicks cannot grant a subscription or credit package twice.
The UI invalidates the summary query after a successful response.

### 3. Provider payment time

Extend the provider status/webhook contract with an optional `paidAt` value.
The PayOS adapter maps `data.transactionDateTime` from webhook payloads and the
first successful transaction returned by the status API. Settlement stores that
timestamp when valid, falling back to the server clock only when PayOS did not
provide one.

### 4. Summary response

Keep all existing summary fields and add:

```ts
totals: {
  // existing fields …
  paidRevenueVnd: number;
  paidOrderCount: number;
};
window: {
  period: AdminRevenuePeriod | 'ROLLING_DAYS';
  from: string;
  to: string;
  timezone: 'Asia/Ho_Chi_Minh';
};
```

Revenue queries explicitly constrain `provider` to the active payment provider
and `currency` to `VND`, then filter `status = 'PAID'` and the resolved paid
timestamp window. Legacy rows without a verification result remain visible;
after an explicit sync, rows confirmed by PayOS remain in the synced revenue
metric, while `NOT_FOUND`, `NOT_PAID`, and `MISMATCH` rows are excluded.
Transient `ERROR` rows retain the previous local value and remain retryable.
The amount remains the final charged `amount_vnd`, which is the amount verified
against PayOS after discounts.

### 5. Admin UI

Replace the generic `7/30/90/365 days` selector on Admin Overview with PayOS-
style period labels. The default becomes `THIS_YEAR` so the first view is
comparable with the supplied PayOS screenshot. The existing Insights page may
continue using `rangeDays` until it is migrated to the shared period contract.

Admin Overview will:

- request the selected `period` and resolved custom dates;
- show `paidRevenueVnd` in the existing VND format;
- show `paidOrderCount` beside the revenue card as a secondary badge;
- expose a `Sync PayOS` action with loading, partial-failure, and retry states;
- refresh the summary after reconciliation;
- label the metric as synced local completed payments, not PayOS account
  balance or net settlement.

If reconciliation cannot find a corresponding local order for a transaction
visible in the PayOS dashboard, the UI will not fabricate a row. The sync result
will report unresolved local pending orders, and the Admin order list remains
the audit surface for follow-up.

## Error handling

- Invalid custom dates return the existing validation error envelope.
- PayOS 401/403 and provider configuration errors fail the sync request with a
  clear Admin-visible message and do not alter local order status.
- PayOS business code 101 (“payment code not found”) is treated as an expired
  local pending order or an unverified legacy paid row, without changing a
  legacy row's `PAID` status.
- PayOS 429 or an individual network failure is recorded in the sync result;
  pending orders remain `PENDING`, while legacy paid rows are marked `ERROR`
  and remain visible and retryable.
- Settlement amount, currency, and payment-link mismatches continue to reject
  the order and are counted as failed reconciliation attempts.

## Testing strategy

### Backend

- Pure period-boundary tests for ICT today, yesterday, week, month, previous
  month, year, previous year, and custom windows.
- Summary tests proving provider/currency/status/window filters, revenue sum,
  order count, and response window metadata.
- Provider adapter tests for PayOS transaction time parsing.
- Settlement tests proving provider `paidAt` is preferred over server time.
- Reconciliation service tests for pending-to-paid settlement, terminal status,
  provider failure, rate-limit failure, and idempotent repeated runs.
- Controller/DTO tests for valid presets and custom-window validation.

### Frontend

- API tests for period parameters and reconciliation route.
- Admin Overview tests for the default `THIS_YEAR` request, period changes,
  VND rendering, order-count badge, and summary invalidation after sync.
- Run the existing lint, typecheck, unit tests, and production build.

## Acceptance criteria

1. Selecting `Năm nay` sends a calendar-year request, not `rangeDays=365`.
2. The response exposes the exact ICT window and completed-order count.
3. A local pending order that PayOS reports as paid is settled and included in
   the next summary.
4. Re-running sync is safe and does not duplicate entitlements.
5. The Admin page no longer silently presents a rolling-30-day value while the
   operator is comparing it with PayOS “Năm nay”.
6. Existing non-revenue Admin summary consumers remain compatible.

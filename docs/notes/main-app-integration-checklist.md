# Main-app integration checklist

Stage: 5 (paste-ready checklist; no code changes in this repo)
Status: ready for main-app PR author

Audience: whoever is opening the PR that lifts Stripe from this prototype into the main TanStack app. Walk the checklist top-to-bottom. Each section calls out which prototype stage the pattern comes from so you can read the original commit if the mechanics aren't obvious.

## Before starting

- [ ] Read the main prototype design doc (repo root `docs/design-track-A.md`) and each `docs/audits/stage-N-audit.md`. The audits are where the "why" for non-obvious design choices lives.
- [ ] Confirm the main app is TanStack Router + TanStack Query. The polling + refund UI pattern in Stage 3+5 assumes both; if either is different, the `useOrderPoll` port needs reshaping.
- [ ] Confirm the main app's DB. Prototype uses bun:sqlite; the idempotency pattern (PK + `INSERT OR IGNORE` + `.changes`) ports 1:1 to Postgres (`INSERT ... ON CONFLICT DO NOTHING` with `RETURNING`-checked row count).
- [ ] Grab a fresh `sk_test_...` key for the integration dev loop. Do NOT copy the prototype's key — it's scoped to this learning account.

## Stage 0–1 foundations to replicate

- [ ] **Pin Stripe SDK + API version.** `stripe@22.1.0` with `apiVersion: "2026-04-22.dahlia"` in the SDK constructor. Pin version via exact match in `package.json` so a random `bun update` doesn't bump behind your back. Every webhook shape assumption in this prototype was tested against that version.
- [ ] **Split dev stack from dev+webhooks.** Two scripts: the fast UI-iteration one (no `stripe listen`) and the full one with the CLI forwarding webhooks. The fast one matters — `stripe listen` output clutters the terminal and adds startup latency you don't want when the task doesn't touch webhooks.
- [ ] **Secrets layout.** Env vars needed: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (from `stripe listen` output or dashboard), `APP_BASE_URL` (feeds hosted Checkout's `success_url` / `cancel_url`). The prototype defaults `APP_BASE_URL` so omitting it doesn't crash dev; production MUST set it and the startup log MUST surface the resolved value.

## Stage 2 — PaymentIntent + Elements

- [ ] **Server-generated `orderId` is UUIDv4.** Never let the browser pick it. The prototype's schema validates `/^[0-9a-f-]+$/` with the UUID segment lengths; user-chosen ids collapse the per-order idempotency key.
- [ ] **Idempotency-Key scheme.** `order:<uuid>:create` for PI create. Extend for new actions: `order:<uuid>:refund` (Stage 5), `order:<uuid>:checkout-session` (Stage 4). The `:action` suffix keeps different ops from colliding.
- [ ] **create-or-reuse route.** `/api/payments/intent` handles both "first time" and "user refreshed the page" in one endpoint. The key test: Stripe's `idempotency_key_in_use` race — two browser tabs both saw "no existing order" and raced into create. Catch the error, sleep ~150ms, re-read the DB, return the winning row. Don't skip this — production traffic WILL hit it.
- [ ] **REUSABLE_STATUSES gate.** Only `requires_payment_method | requires_confirmation | requires_action` are safe to hand back a `client_secret`. `processing` gets a dedicated response with `clientSecret: null` and status `"processing"` so the UI renders a wait page instead of re-mounting PaymentElement.
- [ ] **PaymentElement with `automatic_payment_methods: { enabled: true }`.** Dashboard drives the PM list. Don't hardcode `payment_method_types`.

## Stage 3 — webhooks

- [ ] **Raw body.** Hono users: use `await c.req.text()`, NOT `c.req.raw.text()`. Hono's own error hint warns against `c.req.raw` consumption. Express: `express.raw({ type: 'application/json' })` middleware scoped to the webhook route only.
- [ ] **`constructEventAsync` on Bun / Web Crypto runtimes.** The sync `constructEvent` pulls in Node `crypto`. Pass 300s tolerance explicitly for readable retry-window documentation.
- [ ] **`processed_events (id PK, type, received_at)` + INSERT OR IGNORE.** `.changes > 0` is the "first delivery" signal. Primary key on event.id, not a composite key — Stripe event ids are globally unique.
- [ ] **Filter-first, then idempotency-gate.** Order matters: check `HANDLED_EVENTS.has(event.type)` BEFORE `markEventProcessed`. If you mark unknown types, a future `stripe events resend` backfill for that type will silently skip.
- [ ] **Terminal-state SQL guard.** Put it in the UPDATE WHERE clause, not in application code:
      ```sql
      WHERE order_id = $order_id
        AND (
          status NOT IN ('succeeded','failed','refunded','canceled')
          OR ($status = 'refunded' AND status = 'succeeded')
        )
      ```
      This is the Stage-4-audit M1 fix. Re-delivered stale `payment_intent.processing` after a `succeeded` transition has a NEW `event.id`, so the idempotency gate alone doesn't catch it; this clause does.
- [ ] **UNIQUE INDEX on `orders.payment_intent_id`.** Needed by `getOrderByIntent` which the `charge.refunded` handler uses (charge event carries the intent id, not the order id). UNIQUE because the orderId-keyed create-or-reuse guarantees one PI per order.
- [ ] **Match the shared OrderStatus enum to the full Stripe `PaymentIntent.Status` union.** Include `requires_capture` even if you don't use manual capture today — the `GET /order/:orderId` route parses DB status through zod and will 500 on anything missing.
- [ ] **Unauth'd GET /order/:orderId is PROTOTYPE SCOPE.** Do NOT paste this endpoint into the main app without adding auth. Even with UUID obscurity, the response exposes amount/currency/PI/status. Minimum gate: session-cookie check + ownership verification against a `user_id` column.

## Stage 4 — hosted Checkout

- [ ] **Both surfaces share `orders`.** `payment_intent_data.metadata.order_id` on `sessions.create` propagates `order_id` onto the underlying PI so the PI webhook handlers work for both flows unchanged.
- [ ] **Three `order_id` anchors on the Session.** `client_reference_id`, `metadata.order_id`, AND `payment_intent_data.metadata.order_id`. They look redundant but serve three audiences: dashboard debugging, PI-event path, session-event path.
- [ ] **`success_url` template.** `?order_id=<uuid>&session_id={CHECKOUT_SESSION_ID}` — Stripe fills in the session_id templating. The `session_id` is a first-class support join key in the dashboard; don't discard it.
- [ ] **Handle `checkout.session.{completed,expired,async_payment_succeeded,async_payment_failed}`.** The async_payment_* pair is the terminal signal for delayed-settlement PMs (stablecoin, BACS, SEPA). Without them, async orders stay `processing` forever on the Checkout surface.
- [ ] **`.expired` gate includes `requires_action`.** A user who abandons 3DS mid-challenge lands at `requires_action`; without this, the 24h session expiry doesn't clean them up. Stripe SEPARATELY fires `payment_intent.canceled` for abandoned intents, so this is a safety net — the terminal-status guard absorbs any race.
- [ ] **Don't eagerly cancel on `cancel_url` hit.** User might still complete from the Stripe page if they reopen. Wait for the session event.
- [ ] **`checkout.session.completed` with `payment_status: "unpaid"` means async PM still settling.** Only flip to `succeeded` when `payment_status === "paid"`; otherwise defer to PI events / async_payment_* events.

## Stage 5 — refund

- [ ] **Gate on `order.status === "succeeded"` at the API boundary.** `processing` means the charge hasn't settled; other terminal states have nothing to refund.
- [ ] **DB transition via webhook, not in the POST.** `charge.refunded` → `updateOrderStatus(orderId, "refunded")`. The terminal-state SQL guard has a carve-out for `succeeded → refunded` so this works without loosening the guard globally.
- [ ] **`useOrderPoll` needs `restartKey` + `awaitingTransition` options** for the post-refund polling window. `succeeded` is terminal; the hook's default terminal-stop must be bypassed until `refunded` lands. See `apps/web/src/lib/useOrderPoll.ts` for the ASSUMPTIONS block — port all three (SPA-only, remount reset, timedOutRef one-shot) commentary to the main app so the next maintainer knows the constraints.
- [ ] **Validate Stripe refund shape through zod at the server boundary.** SDK types `Refund.status` as `string | null`; docs promise a specific union. The shared `RefundOrderResponseSchema` narrows this — use it so a novel status from a future API version trips a 500 locally instead of leaking to the client.

## Stablecoin (status: deferred per jurisdiction memo)

- [ ] Read `stablecoin-accept-jurisdiction-decision.md` before touching stablecoin in production. Recommendation is "defer until Q3 2026" with Coinbase Commerce as the specific-deal fallback.
- [ ] If Stripe Stablecoin Accept becomes available on the KR key: all of the code above works as-is. The PM just shows up in the PaymentElement list and dashboard, with the same `checkout.session.async_payment_*` events for settlement. No new routes, no schema change.
- [ ] Re-run the Stage 5 E2E checklist with a stablecoin PM. Specifically verify: does `checkout.session.async_payment_succeeded` actually fire for all stablecoin settlements, or only when settlement delays beyond the synchronous window?

## Testing & ops

- [ ] **Manual verification checklist.** Each `docs/notes/stage-N-*.md` has one. Run them on a clean DB before shipping to production.
- [ ] **Terminal-state regression test.** `stripe events resend <evt_id_of_processing>` after an order is `succeeded`, verify `updated_at` does NOT change. This catches the whole class of bugs the terminal-state guard prevents.
- [ ] **Idempotency-double-click test.** Click the hosted-Checkout submit button twice in quick succession (or run `curl` the create endpoint twice with the same orderId). Should result in one order row and one Session (Stripe's idempotency; verify in dashboard).
- [ ] **Webhook secret rotation.** Have a runbook for rotating `STRIPE_WEBHOOK_SECRET`. Stripe's dashboard lets you have two active endpoints during rotation; swap, then delete old.
- [ ] **Alerting.** Alert on: 5xx rate on `/api/webhooks/stripe`, 5xx rate on `/api/payments/intent`, `refund_shape_unexpected` log line (means Stripe shipped a new Refund.status). None of these are in scope for this prototype but all are required for production.

## What this prototype deliberately did NOT implement

Copy these into the main-app PR description as "out of prototype scope":

- Authentication / authorization (all endpoints unauth'd).
- User-facing email / notifications on order state changes.
- Partial refunds.
- Subscription / recurring billing.
- Multi-currency presentment (prototype hardcoded a single currency per order at create time; no FX).
- Apple Pay / Google Pay / Link wiring beyond what Stripe's automatic_payment_methods exposes.
- CSRF / rate limiting on POST endpoints.
- Observability (no APM wiring; console.error is the whole error story).

## Further reading

- `docs/audits/stage-2-audit.md` through `stage-4-audit.md` — reviewer convergence / disagreement tables. Especially useful when deciding whether a reviewer's comment on the main-app PR applies or is already-resolved prototype context.
- `docs/notes/stage-3-observations.md` — security-relevant notes on the unauth'd status endpoint.
- `docs/notes/stage-4-elements-vs-checkout.md` — the "when to use Elements vs hosted" decision recommendation for the main app.

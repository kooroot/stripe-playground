# Stage 5 — refund + decision docs observations

Stage: 5
Branch: `stage/5-stablecoin-deep-dive`
Status: pre-audit (fill in observed rows during manual E2E)

## What this stage adds

- `apps/api/src/routes/payments.ts` — `POST /api/payments/refund` (full refund only). Gates on DB `order.status === "succeeded"`, calls `stripe.refunds.create({ payment_intent })` with `Idempotency-Key: order:<uuid>:refund`, returns refund shape validated through shared zod.
- `packages/shared/src/index.ts` — `RefundOrderRequestSchema` (`{ orderId }`) + `RefundOrderResponseSchema` (`{ refundId, paymentIntentId, orderId, amount, currency, status }` where status is the Stripe `Refund.status` union narrowed via zod).
- `apps/web/src/components/RefundPanel.tsx` — button + mutation state, shared by both success pages.
- `apps/web/src/lib/useOrderPoll.ts` — grows `UseOrderPollOptions` with `restartKey` (re-anchor 2-min poll budget) and `awaitingTransition` (bypass terminal-stop for succeeded→refunded).
- Both `apps/web/src/routes/checkout/success.tsx` and `.../checkout-hosted/success.tsx` — render `<RefundPanel>` when `order.status === "succeeded"` and wire the re-polling via `refundedAt` + `sawRefunded` state.
- `docs/notes/stablecoin-accept-jurisdiction-decision.md` — Circle/Coinbase Commerce/US subsidiary/defer comparison + recommendation.
- `docs/notes/tempo-watch.md` — quarterly watch note on Tempo.
- `docs/notes/main-app-integration-checklist.md` — paste-ready doc for whoever opens the main-app Stripe PR.

No Stripe SDK version bump; still on `stripe@22.1.0` with `apiVersion: "2026-04-22.dahlia"`.

## Why refund transition stays webhook-driven

The obvious alternative is "update the DB from the refund POST response" since `refunds.create` for a test-mode card returns `status: "succeeded"` synchronously. Rejected because:

1. Production card refunds are NOT always synchronous. The card network can move them through `pending` for hours.
2. Async PMs (stablecoin, SEPA) refund on the settlement rail's timeline — could be days.
3. Writing from the POST path would mean the "source of truth for order state" is sometimes the POST path and sometimes the webhook, per-PM. The prototype's whole premise (Stage 3) is that webhooks are authoritative. Breaking that for refunds erodes the invariant for no gain in the card happy path.

So the POST does the side effect (Stripe API call); the webhook does the state transition. `charge.refunded` handler (Stage 3) does `updateOrderStatus(orderId, "refunded")`, which the Stage-4-audit terminal-state guard explicitly permits (`succeeded → refunded` is the one legal terminal→terminal transition).

## Why `useOrderPoll` needed new options

The hook stops polling on any terminal status. A "succeeded" order that's been sitting open for a while → user clicks refund → webhook lands some seconds later → the hook needs to re-poll past a terminal status to observe the transition. Two problems:

1. **Budget exhausted.** `startedAt = useMemo(() => Date.now(), [])` captured the original mount; if the success page was left open for a minute before refund-click, only ~60s of the 2-min budget remains. `restartKey` re-anchors startedAt.
2. **Terminal-stop.** `refetchInterval` returns `false` for any terminal status. `awaitingTransition` bypasses this check.

The flip-back from `awaitingTransition: true` to `false` is driven by `sawRefunded` state in the success pages: when the poll observes `order.status === "refunded"`, `sawRefunded` becomes true, the next render's `awaitingTransition` is false, and the hook's terminal-stop fires naturally on the next `refetchInterval` call. Clean termination without extra unmount/remount logic.

## Recurring stablecoin — gated, not implemented

Design doc's Stage 5 said "recurring stablecoin subscriptions only if the Stripe account has preview access enabled." Checked dashboard → Payment methods → Stablecoins: no recurring toggle on this account. So the prototype does NOT implement recurring. The jurisdiction memo references this — when/if Stripe opens recurring stablecoin on KR accounts, the main app picks up the same Subscription + PM primitives as card subscriptions, with the webhook events `customer.subscription.*` instead of (or in addition to) `payment_intent.*`.

## Manual verification checklist

Run `bun run dev:webhooks`. Then:

1. **Happy-path card refund (Elements).**
   - `/checkout` → pay with `4242 4242 4242 4242`.
   - Wait for poll to show `succeeded`.
   - Observe "refund" button appears.
   - Click "refund".
   - Button flips to "refund requested"; stripe status (pending|succeeded) shown under it.
   - Within ~5s, order status polls to `refunded`. Polling stops.
   - Verify in Stripe dashboard: Payment shows refund row; Charge shows `refunded: true`.

2. **Happy-path card refund (hosted Checkout).**
   - `/checkout-hosted` → redirect to Stripe → pay `4242 4242 4242 4242`.
   - Return to `/checkout-hosted/success?order_id=...&session_id=...`.
   - Wait for `succeeded`.
   - Click "refund".
   - Same observation: flip to `refunded` via webhook within seconds.

3. **Idempotency on double-click.**
   - Open browser devtools → Network tab.
   - Click "refund" → immediately click "refund" again (the button is disabled-on-pending so this tests if click events queue).
   - Should produce one `POST /api/payments/refund` in Network tab (disabled button prevents second send). If you force a second by curl'ing `/api/payments/refund` with the same orderId: Stripe's idempotency-key cache returns the SAME Refund object → only one `charge.refunded` webhook fires.

4. **Terminal-state guard (regression).**
   - Complete a payment, note the PI event ids in `stripe listen` output.
   - After order is `succeeded`, run `stripe events resend <evt_id_of_processing>` (grab an id from the original PI flow).
   - Verify order status stays `succeeded`. `updated_at` should not change.
   - Now click refund; order flips `refunded` normally.
   - Run `stripe events resend <evt_id_of_processing>` AGAIN (after refund).
   - Order stays `refunded`. The SQL guard blocks `refunded → processing`.

5. **Not-refundable gate.**
   - Attempt refund against a non-succeeded order (e.g. an order in `processing` — trigger via `4000 0000 0000 0077` bank-debit test numbers or just `curl` a POST to `/api/payments/refund` with an unknown orderId).
   - Expect 409 `not_refundable` for non-succeeded, 404 `not_found` for unknown orderId.
   - Validation: empty body → 400 Zod issues.

6. **Refund on async PM (if stablecoin test-mode enabled).**
   - Pay with USDC test mode via hosted Checkout.
   - Once `succeeded`, click refund.
   - Observe: does `stripe.refunds.create` return `status: "pending"`?
   - Does `charge.refunded` eventually fire? How long?
   - Fill in observations below.

## Observations table (fill during E2E)

| Scenario | Initial refund.status | `charge.refunded` delay | Order flips to `refunded`? | Notes |
|---|---|---|---|---|
| Card 4242 (Elements) |   |   |   |   |
| Card 4242 (hosted) |   |   |   |   |
| Async PM (stablecoin) |   |   |   |   |
| Non-succeeded order |   |   |   | 409 expected |
| Unknown orderId |   |   |   | 404 expected |

## Known limitations / deferred

- **Partial refund UI.** Current RefundPanel does full-amount only. Stripe's API supports `amount:` parameter; extending would need a number input and a server-side validation against `order.amount - already_refunded`. Deferred as out-of-prototype-scope.
- **Refund reason.** `stripe.refunds.create` accepts `reason: "duplicate" | "fraudulent" | "requested_by_customer"`. Prototype doesn't pass one (Stripe defaults to null). Main app should plumb a reason dropdown.
- **Refund on refunded order.** The UI hides the button once `order.status === "refunded"`. The server ALSO gates at `succeeded`-only, so even if someone curl's a refund against an already-refunded order, they get 409 `not_refundable`. Double-layer protection.
- **Refund timeout UX.** `useOrderPoll`'s `timedOut` fires if the webhook doesn't land in 2 min. For refunds the wait can legitimately be longer (async PMs). For the prototype this is acceptable — the user sees "webhook didn't land…" and can check the dashboard. Production would either extend the budget for refunds specifically or offer an explicit "refresh status" button.

## Cross-references

- `docs/notes/stablecoin-accept-jurisdiction-decision.md` — why stablecoin is deferred as a production PM and what triggers re-opening that decision.
- `docs/notes/tempo-watch.md` — quarterly watch on Tempo; separate from the jurisdiction decision.
- `docs/notes/main-app-integration-checklist.md` — paste-ready checklist; the Stage 5 refund section summarizes the mechanics above.

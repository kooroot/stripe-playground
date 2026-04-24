# Stage 3 — Webhook verify + idempotency observations

Stage: 3
Branch: `stage/3-webhook-idempotency`
Status: pre-audit (fill in during manual E2E)

## What this stage adds

- `POST /api/webhooks/stripe` — raw-body HMAC verify via `stripe.webhooks.constructEventAsync` (Web Crypto, Bun-native).
- `processed_events (id PK, type, received_at)` — `INSERT OR IGNORE` gates every handler on first delivery. Stripe re-deliveries (network retries, `stripe events resend`, CLI re-run) become 200-noop.
- Handlers: `payment_intent.{succeeded,processing,payment_failed,canceled}`, `charge.refunded`. Each maps to an `orders.status` transition. Unknown event types return 200 so Stripe doesn't retry for 3 days.
- `GET /api/payments/order/:orderId` — returns the DB-authoritative status. `/checkout/success` polls it every 2s until terminal (`succeeded|failed|refunded|canceled`).
- Root `bun run dev:webhooks` adds `stripe listen --forward-to http://127.0.0.1:8787/api/webhooks/stripe`. Base `bun run dev` stays webhook-less for fast UI iteration.

## Why raw body

Hono's `c.req.json()` consumes and re-serializes the body. Stripe signed the bytes exactly as sent, so any normalization changes the HMAC input. `c.req.raw.text()` reads the underlying Fetch Request body once, in its original form.

## Why `constructEventAsync`

Bun's default runtime uses Web Crypto (`SubtleCrypto`). The sync `constructEvent` path in the Stripe SDK requires Node's `crypto` module, which Bun only exposes under `node:crypto`. The async variant uses Web Crypto directly and works out of the box.

## Why idempotency BEFORE dispatch

Stripe docs guarantee at-least-once delivery. The replay surface includes:
- Network blip after we 200 but before ack propagates back
- `stripe events resend` from CLI during verification
- Stripe dashboard "Resend" button
- Any non-2xx return from us (Stripe retries up to 3 days)

`markEventProcessed` is atomic (PK collision → 0 rows changed). If it returns false we skip the handler without side effects; we still return 200 so Stripe stops retrying.

**Known limitation for this prototype:** the insert is NOT in the same transaction as the handler's order-status update. A crash between `markEventProcessed` returning true and `updateOrderStatus` running would leave the event marked processed but the order un-transitioned — on next delivery the idempotency gate blocks the replay. Production would wrap both in `BEGIN IMMEDIATE; ... COMMIT` (bun:sqlite's `db.transaction(() => { ... })()` helper).

## Manual verification checklist

1. **Setup**:
   - `.env` has `STRIPE_WEBHOOK_SECRET=whsec_...`. If missing, run `stripe listen --forward-to ...` once — the whsec prints on stdout.
   - `bun run dev:webhooks` → api logs `webhooks=on`.

2. **Happy path**:
   - `/checkout` → 4242 4242 4242 4242 → redirected to `/checkout/success?order_id=...`.
   - Success page shows `order status` transition: `requires_payment_method` → `processing` → `succeeded` as webhooks fire.
   - Stripe CLI logs `payment_intent.succeeded [200]`.

3. **Idempotency replay**:
   - Note event id from CLI output.
   - `stripe events resend evt_XXX`.
   - API returns `{ok: true, duplicate: true}`; no extra `updateOrderStatus` call (verify via `sqlite3 apps/api/.data/stripe-prototype.db "SELECT order_id, status, updated_at FROM orders"` — `updated_at` does not change on the replay).

4. **Signature failure**:
   - `curl -X POST http://127.0.0.1:8787/api/webhooks/stripe -H 'stripe-signature: t=1,v1=bad' -d '{}'`
   - Expect `400 {"error":{"type":"signature_mismatch"}}`.

5. **Missing signature**:
   - `curl -X POST http://127.0.0.1:8787/api/webhooks/stripe -d '{}'`
   - Expect `400 {"error":{"type":"missing_signature"}}`.

6. **Decline path**:
   - Card `4000 0000 0000 0002` → `payment_intent.payment_failed` webhook → order status `failed`.

7. **Refund path**:
   - Complete a succeeded payment first.
   - `stripe payment_intents refund pi_XXX` (or dashboard → Refund).
   - Wait for `charge.refunded` → order status `refunded`.

8. **Unknown event**:
   - `stripe trigger customer.created`.
   - API returns `{ok: true, ignored: "customer.created"}`; nothing written to orders.

9. **Orphan intent**:
   - `stripe trigger payment_intent.succeeded` with no `metadata.order_id`.
   - Handler returns without updating any row (we don't know which order); no error.

10. **Webhooks-off smoke**:
    - Unset `STRIPE_WEBHOOK_SECRET`, restart. `/api/webhooks/stripe` 404s.

## Numbers to capture (fill during E2E)

| Scenario | Stripe latency (redirect → webhook land) | UI polling ticks until terminal |
|---|---|---|
| Card 4242 |   |   |
| Card 3DS 3155 |   |   |
| Stablecoin USDC (if available in test mode) |   |   |
| Refund |   |   |

## Open questions for audit

- Should `markEventProcessed` + handler be transactional in a prototype? Current take: document the gap, defer to production.
- Is the `200 ignored: <type>` response shape worth exposing? Alternative: log server-side only, return empty 200.
- Should we expose raw Stripe event id via `GET /api/payments/order/:orderId` for audit trace? Likely yes for Stage 4 hosted-vs-elements comparison.

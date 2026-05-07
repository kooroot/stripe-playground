# stripe-prototype

Hands-on learning prototype for Stripe payment integration, built on Bun + TanStack + Hono.

Full design and stage plan: [docs/plans/2026-04-24-stripe-prototype-track-a-design.md](./docs/plans/2026-04-24-stripe-prototype-track-a-design.md).

## Status

Stage 5 — Full refund flow + stablecoin/Tempo deep-dive. `POST /api/payments/refund` issues a full refund via `stripe.refunds.create` with an order-derived idempotency key, gated on `orders.status == "succeeded"` and pre-checked against `refunds.list` to avoid double-issuing. Both `/checkout/success` and `/checkout-hosted/success` expose a Refund button and reflect the `refunded` state once `charge.refunded` lands. Stablecoin acceptance / Tempo / main-app integration notes live under [`docs/notes/`](./docs/notes/).

Stage 4 — Hosted Checkout vs Elements. `POST /api/checkout/session` creates a Stripe-hosted Checkout Session and `/checkout-hosted` redirects users to it; `/checkout-hosted/success` and `/checkout-hosted/cancel` close the loop via the shared `useOrderPoll` hook. `checkout.session.{completed,async_payment_succeeded,async_payment_failed,expired}` are dispatched from the same webhook handler, so order state stays webhook-authoritative across both flows. Comparison memo: [`docs/notes/stage-4-elements-vs-checkout.md`](./docs/notes/stage-4-elements-vs-checkout.md).

Stage 3 — Webhook signature verify + idempotency. `POST /api/webhooks/stripe` verifies the Stripe-Signature header against the raw request body, gates on a `processed_events` table keyed by `event.id`, and drives `orders.status` transitions from `payment_intent.{succeeded,processing,payment_failed,canceled}` and `charge.refunded`. `/checkout/success` polls `GET /api/payments/order/:orderId` until the status is terminal, so the page reflects webhook truth rather than the Stripe redirect param.

Stage 2 — Elements + order-keyed PaymentIntent. `POST /api/payments/intent` is the order-keyed create-or-reuse endpoint backed by `bun:sqlite` (`apps/api/.data/`). The web app at `/checkout` uses TanStack Query to create the intent and renders a Stripe `PaymentElement` with dynamic payment methods (cards + crypto + whatever the dashboard allows).

## Stack

- **Runtime:** Bun 1.2.8
- **Frontend:** TanStack Router + TanStack Query + React + Vite (`apps/web`)
- **Backend:** Hono on Bun (`apps/api`)
- **Storage:** `bun:sqlite` (webhook idempotency, order state)
- **Shared types:** Zod via `packages/shared`
- **Payments:** `stripe` SDK, Stripe CLI for local webhook forwarding

## Quickstart

```bash
bun install
cp .env.example .env   # fill STRIPE_SECRET_KEY + VITE_STRIPE_PUBLISHABLE_KEY (test mode)
stripe login           # one-time, opens a browser

# start web (Vite, 5173) + api (Hono, 8787) in one pane
bun run dev

# For Stage 3 webhook flows — also runs `stripe listen`, which prints the
# whsec_... secret on first start. Paste that into .env as STRIPE_WEBHOOK_SECRET
# and restart the script; the api logs `webhooks=on` once the secret is picked up.
bun run dev:webhooks

# Elements flow (Stage 2/3): http://127.0.0.1:5173/checkout
#   - generates a UUID orderId client-side
#   - POST /api/payments/intent creates a PaymentIntent (dynamic PMs)
#   - PaymentElement renders every dashboard-enabled method
#   - submit with test card 4242… for happy path
#     or 4000 00 25 0000 3155 for 3DS challenge
# Hosted Checkout flow (Stage 4): http://127.0.0.1:5173/checkout-hosted
#   - POST /api/checkout/session, redirect to Stripe-hosted page
# Both success pages poll GET /api/payments/order/:orderId until the
# webhook flips status to `succeeded` / `failed` / `refunded`, and expose a
# Refund button (Stage 5) that calls POST /api/payments/refund.

# Stage 3 webhook smoke test (in another shell, with dev:webhooks running):
#   stripe trigger payment_intent.succeeded
#   stripe events resend <evt_id>   # verify idempotency — second delivery is a no-op

# seed practice objects (Stage 1)
bun run seed
bun run seed -- --cleanup           # also clean up
bun run seed -- --tag=<old> --cleanup   # recover orphans from a failed run
```

### Environment precedence

Bun auto-loads `.env` then `.env.$NODE_ENV` then `.env.local`; shell and CI
environment variables override all of the above. `STRIPE_SECRET_KEY` must
start with `sk_test_` and `VITE_STRIPE_PUBLISHABLE_KEY` with `pk_test_` —
live keys are rejected at startup in both the server (`loadEnv`) and the
web bundle (`lib/stripe.ts`). `STRIPE_WEBHOOK_SECRET` (must start with
`whsec_`) is optional at startup — when absent the api still runs but
`/api/webhooks/stripe` is not mounted.

## Layout

```
apps/web/           TanStack Router app (Vite, React 19, Stripe Elements)
apps/api/           Hono server
  src/db.ts         bun:sqlite orders table
  src/routes/       Hono route modules
apps/api/.data/     SQLite file lives here (gitignored)
packages/shared/    Zod schemas shared by web + api + scripts
scripts/            Stripe seeding utilities
docs/plans/         Design docs
docs/audits/        /codex + /code-review outputs per stage
docs/notes/         Learning notes + observations per stage
```

## Scope (what this repo is NOT)

- No production keys, test mode only
- No Web3 direct wallet (see separate `alloy-prototype`)
- No Tempo blockchain integration (not in public Stripe API)
- No Connect/marketplace flows (Track C, future)

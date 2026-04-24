# stripe-prototype

Hands-on learning prototype for Stripe payment integration, built on Bun + TanStack + Hono.

Full design and stage plan: [docs/plans/2026-04-24-stripe-prototype-track-a-design.md](./docs/plans/2026-04-24-stripe-prototype-track-a-design.md).

## Status

Stage 2 — PaymentIntent + Elements. `POST /api/payments/intent` is an order-keyed create-or-reuse endpoint backed by `bun:sqlite` (`apps/api/.data/`). The web app at `/checkout` uses TanStack Query to create the intent and renders a Stripe `PaymentElement` with dynamic payment methods (cards + crypto + whatever the dashboard allows).

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

# open http://127.0.0.1:5173/checkout
#   - generates a UUID orderId client-side
#   - POST /api/payments/intent creates a PaymentIntent (dynamic PMs)
#   - PaymentElement renders every dashboard-enabled method
#   - submit with test card 4242… for happy path
#     or 4000 00 25 0000 3155 for 3DS challenge

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
web bundle (`lib/stripe.ts`).

Stage 3 will add `stripe listen` to the dev script.

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

# stripe-prototype

Hands-on learning prototype for Stripe payment integration, built on Bun + TanStack + Hono.

Full design and stage plan: [docs/plans/2026-04-24-stripe-prototype-track-a-design.md](./docs/plans/2026-04-24-stripe-prototype-track-a-design.md).

## Status

Stage 1 — Stripe CLI + seed script. Bun workspace, Hono API skeleton with `/health` probing `stripe.balance.retrieve()`, and `scripts/seed.ts` creating Customer/Product/Prices in test mode.

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
cp .env.example .env   # fill in STRIPE_SECRET_KEY + VITE_STRIPE_PUBLISHABLE_KEY (test mode)

# one-time Stripe CLI login (opens a browser)
stripe login

# seed practice objects (Customer + Product + Prices)
bun run seed
bun run seed -- --cleanup   # same + delete at the end

# start the api (Hono on Bun)
bun run dev
curl http://localhost:8787/health   # should return {ok:true, mode:"test"}
```

Stage 2 adds the web app; Stage 3 adds `stripe listen` to the dev script.

## Layout

```
apps/web/        TanStack Router app
apps/api/        Hono server
packages/shared/ Zod schemas
scripts/         Stripe seeding utilities
docs/plans/      Design docs
docs/audits/     /codex + /code-review outputs per stage
docs/notes/      Learning notes
```

## Scope (what this repo is NOT)

- No production keys, test mode only
- No Web3 direct wallet (see separate `alloy-prototype`)
- No Tempo blockchain integration (not in public Stripe API)
- No Connect/marketplace flows (Track C, future)

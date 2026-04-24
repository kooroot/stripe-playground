# stripe-prototype

Hands-on learning prototype for Stripe payment integration, built on Bun + TanStack + Hono.

Full design and stage plan: [docs/plans/2026-04-24-stripe-prototype-track-a-design.md](./docs/plans/2026-04-24-stripe-prototype-track-a-design.md).

## Status

Scaffold stage (Stage 0). No code yet — see design doc for the staged rollout.

## Stack

- **Runtime:** Bun 1.2.8
- **Frontend:** TanStack Router + TanStack Query + React + Vite (`apps/web`)
- **Backend:** Hono on Bun (`apps/api`)
- **Storage:** `bun:sqlite` (webhook idempotency, order state)
- **Shared types:** Zod via `packages/shared`
- **Payments:** `stripe` SDK, Stripe CLI for local webhook forwarding

## Quickstart (after Stage 1)

```bash
bun install
cp .env.example .env   # fill in test keys
bun run dev            # web + api + stripe listen
```

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

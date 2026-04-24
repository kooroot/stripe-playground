# Stripe Prototype — Track A Design

Date: 2026-04-24
Status: Active
Scope: Learning/prototype project for Stripe integration patterns before embedding in main app.

## Purpose

Hands-on learning of Stripe's payment primitives (Payment Intents, Elements, Checkout, Webhooks, Stablecoin Payments) using a production-shaped stack, so the final integration into the main TanStack app is a paste-in operation, not a learning exercise.

## Out of Scope (explicit)

- **Web3 direct wallet payments** (EIP-1193, viem/alloy). Deferred to a follow-up prototype; the existing `alloy-prototype` repo already covers server/browser signing patterns.
- **Tempo blockchain integration.** Tempo is Stripe+Paradigm's enterprise L1 (mainnet since 2026-03, advisory service since 2026-04); not exposed through the public Stripe API yet. Monitored only.
- **Subscription/Connect flows** beyond a short Stage 5 extension. Track B/C are future projects.
- **Production deployment.** Everything runs in Stripe test mode; no production API keys, no live business registration.

## Accept-Side Jurisdiction (Critical)

**Stripe Stablecoin Payments accept is US-business-only** as of 2026-04. The owning entity here is KR-based, so while this prototype will exercise the full API surface in **test mode** (country-agnostic), *shipping stablecoin accept into the main production app requires a separate path*:

- Circle Payments direct integration (mint/receive USDC)
- Coinbase Commerce (hosted crypto checkout)
- US subsidiary registered for Stripe stablecoin accept

Stage 5 explicitly produces a decision memo (`docs/notes/stablecoin-accept-jurisdiction-decision.md`) comparing these options. Card payments and Stripe Checkout/Elements itself have no such constraint.

## Stack

| Layer | Choice | Rationale |
|---|---|---|
| Runtime | Bun 1.2.8 | User's default runtime |
| Frontend | TanStack Router + TanStack Query + React + Vite | User's default web stack |
| Backend | **Hono** on Bun | Clean routing, easy raw-body webhook handling, zero deps beyond bun |
| Storage | **`bun:sqlite`** | Webhook idempotency + order state without Postgres overhead |
| Monorepo | **Bun workspaces** | Built-in, no Turborepo needed for 3 packages |
| Schema | Zod | Shared across web/api via `packages/shared` |
| Stripe SDK | `stripe` (server) + `@stripe/stripe-js` + `@stripe/react-stripe-js` | Official |
| Dev orchestration | `concurrently -k` to run web+api+stripe-listen | Borrowed from `alloy-prototype` pattern |

## Repository Layout

```
stripe-prototype/
├── apps/
│   ├── web/                 # TanStack Router + Query app
│   │   ├── src/
│   │   │   ├── main.tsx
│   │   │   ├── routes/      # file-based routing
│   │   │   └── lib/stripe.ts
│   │   ├── index.html
│   │   ├── vite.config.ts
│   │   └── package.json
│   └── api/                 # Hono server
│       ├── src/
│       │   ├── index.ts
│       │   ├── routes/payments.ts
│       │   ├── routes/webhooks.ts
│       │   └── db.ts
│       └── package.json
├── packages/
│   └── shared/              # Zod schemas + shared types
│       ├── src/index.ts
│       └── package.json
├── scripts/
│   └── seed.ts              # Stripe Customer/Product/Price seeding
├── docs/
│   ├── plans/
│   ├── audits/              # /codex + /code-review outputs per stage
│   └── notes/               # learning notes, comparison tables
├── .env.example
├── .gitignore
├── package.json             # root, workspaces
├── tsconfig.base.json
└── README.md
```

## Stage Plan

Each stage ends with: (1) `tsc --noEmit` clean, (2) manual end-to-end verification in Stripe test mode, (3) `git commit` + `git push`, (4) `/codex` review + `/code-review` review, (5) `docs/audits/stage-N-audit.md` summarizing both reviews, (6) fix issues before next stage.

### Stage 0 — Scaffold & design (this commit)

- Design doc (this file)
- Monorepo skeleton: root `package.json`, `tsconfig.base.json`, `.gitignore`, `.env.example`, `README.md`
- Workspace skeletons for `apps/web`, `apps/api`, `packages/shared` (package.json + tsconfig.json each, minimal src stub)
- `bun install` works, `bun run typecheck` passes across workspaces
- Commit: `chore: initial scaffold with design doc`

### Stage 1 — Stripe CLI + seed script (0.5 day)

- Install Stripe CLI (`brew install stripe/stripe-cli/stripe`), `stripe login` against test mode
- `.env` populated with `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY` (test keys only)
- `scripts/seed.ts`: programmatically create one Customer, one Product, one one-time Price and one recurring Price; list; delete
- Verify objects in dashboard test mode
- Commit + push + audit

### Stage 2 — PaymentIntent + Elements (card + stablecoin) (2.5–3 days)

- **Payment method selection:** default to Stripe's dynamic/automatic payment methods (omit `payment_method_types` and use dashboard-driven PM availability) so Payment Element can surface all eligible methods without us hardcoding the list. Pin Stripe API version explicitly on the SDK client. A separate experiment commit in this stage may also exercise manual `payment_method_types: ['card', 'crypto']` for comparison — documented as a secondary path, not the baseline.
- **Order-keyed PaymentIntent:** the API creates-or-reuses a PaymentIntent per `orderId` (server-generated UUID stored in SQLite `orders` table), not per request. Every response attaches `metadata.order_id`. Retries from the browser hit the same intent. This replaces the earlier "amount+currency → new intent each call" shape.
- `apps/api`:
  - `POST /api/payments/intent` — body `{ orderId, amount, currency }` → look up existing open intent for `orderId`; if none, create; always respond with `client_secret`. `Idempotency-Key` header surfaced to Stripe SDK.
  - Zod validation on input; shared schema in `packages/shared`
- `apps/web`:
  - Route `/checkout` — TanStack Query `useMutation` to create intent, `<Elements>` + `<PaymentElement>`
  - Routes `/checkout/success`, `/checkout/failed` handle redirect
- Card flow verification:
  - `4242 4242 4242 4242` happy path
  - `4000 0025 0000 3155` 3DS challenge
  - `4000 0000 0000 0002` declined
- Stablecoin flow verification:
  - Enable "Stablecoins and Crypto" method in dashboard test mode
  - MetaMask + Polygon Amoy testnet, Circle faucet (test USDC)
  - Complete a stablecoin test payment, capture onchain tx hash and Stripe event
- Notes in `docs/notes/stage-2-observations.md`: card vs stablecoin UX, timing, failure modes
- Commit + push + audit

### Stage 3 — Webhook verify + idempotency (1–1.5 days)

- `apps/api`:
  - `POST /api/webhooks/stripe` — **raw body** via `c.req.raw.text()`, `stripe.webhooks.constructEvent()` for signature verify
  - `db.ts` via `bun:sqlite`: table `processed_events(id TEXT PRIMARY KEY, type, received_at)` for idempotency
  - Handlers: `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.refunded`
  - Drive order state transitions from webhooks, not client redirects
- Local dev: `stripe listen --forward-to localhost:PORT/api/webhooks/stripe`
- Test: `stripe trigger payment_intent.succeeded` + real test-mode completion
- Verify idempotency: replay same event, confirm no double-processing
- Commit + push + audit

### Stage 4 — Checkout (hosted) vs Elements comparison (0.5–1 day)

- `apps/api`: `POST /api/checkout/session` — create Stripe Checkout Session, return `url`
- `apps/web`: `/checkout-hosted` route redirecting to Stripe-hosted page
- Run the same Product through both flows; capture webhook event shape differences
- Comparison table in `docs/notes/stage-4-elements-vs-checkout.md`
- Commit + push + audit

### Stage 5 — Stablecoin deep-dive + jurisdiction decision + Tempo watch (1 day)

- **Recurring stablecoin subscriptions** *only if* the Stripe account has preview access enabled at time of execution (check dashboard → Payment methods → Stablecoins → recurring status). If not available, skip and flag as "gated on Stripe preview" in the notes.
- **One-time stablecoin refund flow** (USDC back to original wallet) — always attempted, not preview-gated.
- `docs/notes/stablecoin-accept-jurisdiction-decision.md` — **decision memo** for the main app: Circle Payments direct vs Coinbase Commerce vs US subsidiary vs "defer stablecoin accept." Include cost/complexity/regulatory comparison.
- `docs/notes/tempo-watch.md` — current Tempo status, what changes would need to happen for general API exposure.
- `docs/notes/main-app-integration-checklist.md` — paste-ready checklist for main app.
- Commit + push + audit

## Audit Protocol

Every stage lands via its own `stage/N-<name>` branch and pull request. After implementation is committed:

1. `/codex` — Codex rescue subagent review pass
2. `/code-review` — code-review skill pass (independent second opinion)
3. Consolidate findings into `docs/audits/stage-N-audit.md` (one file per stage, with severity-tagged punch list and an "explicitly verified correct" section)
4. Classify each finding:
   - **BLOCKER** — stage reopens; PR cannot merge until fixed on the same branch
   - **MAJOR** — fix on the same branch before merge (security, correctness, type-safety, plan divergence)
   - **MINOR / NIT** — open a GitHub issue on `kooroot/stripe-playground`, labeled `stage-N` + `minor`/`nit`, linked from the PR description; may defer to a later stage
5. Fix commit(s) on the stage branch: `fix(stage-N): <finding>` — one commit per grouped finding when practical
6. Re-push; the PR absorbs fix commits
7. When both reviews return clean (or only open issues remain), squash-merge the PR to `main`
8. Only then unblock the next stage's task

## Known Constraints

- **Accept-side nationality limit:** already surfaced above in "Accept-Side Jurisdiction." Stage 5 delivers the decision memo.
- **Tempo opacity:** Tempo not in public Stripe API. Re-evaluate at main-app integration time.
- **Recurring stablecoin:** Stripe's recurring stablecoin subscription feature may be in private preview at execution time. Stage 5 gates this check before attempting the flow.
- **Context decay discipline (CLAUDE.md):** re-read files before editing, grep for all reference forms when renaming, run typecheck before claiming completion.

## Success Criteria

- All 6 stages merged to `main` with green audits
- `bun run dev` brings up web + api + stripe listen in one command
- README contains a copy-pasteable integration checklist for the main app
- Zero production API keys in repo history

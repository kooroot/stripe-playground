# Stage 1 Audit

**Commit reviewed:** `5825da1` on `stage/1-stripe-cli-seed`
**Fixes commit:** (this commit — `fix(stage-1): …`)
**Reviewed:** 2026-04-24
**Reviewers:** `superpowers:code-reviewer` + `codex:codex-rescue` (parallel, independent)
**Outcome:** 2 BLOCKER (codex-only), multiple MAJOR (both reviewers converged), several MINOR — all applied on the same branch.

## Consolidated findings

### BLOCKER — fixed

| # | Location | Finding | Fix applied |
|---|---|---|---|
| B1 | `scripts/seed.ts` cleanup path | `stripe.products.del()` on a Product that still has attached Prices returns 400 — prices cannot be hard-deleted (only deactivated), and a Product with any Prices cannot be hard-deleted either. The original `destroy()` would have failed end-to-end on the first real cleanup run. | Replaced `products.del` with `products.update({ active: false })` (archive). Prices remain deactivated via `prices.update({ active: false })`. Customer is still hard-deleted. |
| B2 | `apps/api/src/env.ts` | Stage 1 policy is test-mode-only, but the env schema accepted both `sk_test_` and `sk_live_`. A misplaced `.env` could have the API report `mode: "live"` and the seed script transact live in a future stage that reused `loadEnv`. | Tightened regex to `^sk_test_` only. `STRIPE_SECRET_KEY` starting with `sk_live_` now aborts at startup with a clear error. Escape hatch for live mode (if ever needed later) would be a separate env var, not a relaxed regex. |

### MAJOR — fixed

| # | Location | Finding | Fix applied |
|---|---|---|---|
| M1 | `apps/api/src/stripe.ts` + `scripts/seed.ts` | Stripe client constructed without `apiVersion`. Wire-level behavior drifts silently with SDK bumps or account default changes. | Pinned `apiVersion = '2026-04-22.dahlia'` (matches `stripe@22.1.0` default, verified via `node_modules/stripe/esm/apiVersion.js`). Exported `STRIPE_API_VERSION` constant. |
| M2 | `scripts/seed.ts` | Duplicated env validation (own `Bun.env.STRIPE_SECRET_KEY.startsWith` check) and instantiated a second Stripe client instead of reusing `makeStripe`. Two code paths for one secret is a classic drift bug. | Seed now imports `loadEnv` + `makeStripe` from `apps/api/src`. Single validation surface; single pinned client. The `sk_live_` hard-block from B2 protects seed too. |
| M3 | `scripts/seed.ts` Search queries | Used `metadata['seed_tag']:'…'` (single quotes). Stripe's Search docs specify double quotes (`metadata["key"]:"value"`). Single-quoted form works on some shards and fails on others — latent bug that a mock wouldn't catch. | Switched to `metadata["seed_tag"]:"${tag}"`. Verified against docs.stripe.com/search. |
| M4 | `scripts/seed.ts` eventual consistency | 2-second sleep before Search was a magic number; Stripe SDK types themselves warn "searchable in less than a minute, longer during outages." | Replaced with `retry()` helper: 4 attempts, exponential backoff from 750ms. Returns best-effort result; cleanup remains ID-driven regardless of Search success. |

### MINOR — fixed in this commit

| # | Location | Finding | Fix applied |
|---|---|---|---|
| m1 | `apps/api/src/index.ts` `/health` | Returned `err.message` which can include last-4 of the key, request URL, request-id, etc. Leaks internals. | Type-branch on `Stripe.errors.StripeError`; respond with `{ type, code, requestId }` only. 503 on connection errors, 500 on others. `Cache-Control: no-store` added. |
| m2 | `scripts/seed.ts` `destroy()` | Any single failure aborted cleanup; remaining objects leaked. | Each step wrapped in `tryStep()` — logs failure and continues. Cleanup is now best-effort by design. |
| m3 | `packages/shared/src/index.ts` `IsoCurrencySchema` | `z.string().length(3)` admitted `"123"` / `"us$"`. | Added `/^[A-Za-z]{3}$/` regex before lowercase transform. |
| m4 | `scripts/seed.ts` CLI ergonomics | Couldn't clean up a previous-run tag (always generated a fresh `seed-${Date.now()}`). | Added `--tag=<value>` flag. `--tag=X` alone lists; `--tag=X --cleanup` discovers via Search then deletes. Unlocks recovery from a failed seed. |

### MINOR — filed as GitHub issues

| # | Scope | Issue |
|---|---|---|
| i-stage1-A | Stage 3 prep | Reserve `POST /webhook` route before any global JSON/body-parser middleware lands; webhook needs raw body. |
| i-stage1-B | Any stage | Sanitized startup config log (mode, port, DB path) + env precedence doc in README. |
| i-stage1-C | Stage 3 | Resolve `DATABASE_URL` via `import.meta.dir` not `process.cwd()` so CWD shifts don't fork the idempotency DB. |

### NIT — wontfix / note-only

| # | Location | Finding | Disposition |
|---|---|---|---|
| n1 | `scripts/seed.ts:1` | Shebang `#!/usr/bin/env bun` but file isn't `chmod +x` and is always run via `bun run`. | Removed shebang; matches actual invocation. |
| n2 | seed-tag format | `metadata.seed_tag = seed-${Date.now()}` → suggested `seed_${crypto.randomUUID().slice(0,8)}` for dashboard hygiene. | Wontfix — `Date.now()` is human-sortable; dashboard noise is negligible at this scale. |
| n3 | `.env.example` | `STRIPE_SECRET_KEY` vs `VITE_STRIPE_PUBLISHABLE_KEY` name asymmetry. | Intentional — VITE_ prefix is required for Vite client-bundle exposure. No change. |
| n4 | `apps/api/src/index.ts:28-31` | `export default { port, fetch }` shape. | Verified correct for `Bun.serve`. |

## Explicitly verified correct (coverage evidence)

Both reviewers independently validated:
- zod schema shape for Stage-1 env (`STRIPE_SECRET_KEY` required, `STRIPE_WEBHOOK_SECRET` optional-until-Stage-3, `API_PORT` coerced, `DATABASE_URL` defaulted).
- `Bun.env` (which is `process.env` under the hood) as the right source; precedence is `.env` < `.env.$NODE_ENV` < `.env.local` < shell/CI.
- `z.coerce.number().int().positive()` on `API_PORT` (coercion needed because env values are strings).
- `typescript: true` on Stripe client (stricter TS types).
- Workspace protocol `"@stripe-prototype/shared": "workspace:*"` correct for Bun.
- `bun-types` pin to `1.2.8` (matches runtime), issue #3 closed.
- `concurrently -k -n api` in root `dev` (issue #4 closed).
- Price deactivation (not deletion) ordering: prices → product archive → customer delete.
- `recurring: { interval }` shape on Price create.
- `tsconfig.base.json` strict options (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`) — the `seed.ts` conditional-spread pattern for `description` is required precisely because of `exactOptionalPropertyTypes`.

## Reviewer disagreement / ambiguity

- **Search query quoting:** code-reviewer flagged single-quote as MAJOR with high confidence; codex flagged as MINOR ("exact syntax unverified from SDK"). Resolved by WebFetch to docs.stripe.com/search which confirms double-quote is canonical. Fix applied (M3).
- **`sk_live_` at env layer:** code-reviewer flagged as m1 (MINOR "set the wrong precedent"); codex flagged as BLOCKER ("live key would start the API in live mode"). Resolved by adopting codex's stricter reading — Stage 1/2 policy is test-only, so the env schema enforces it. Easy to relax later with explicit opt-in.

## End-to-end verification

- `bun --filter '*' typecheck` exits 0 after all fixes.
- End-to-end seed against a real `sk_test_` account has NOT been performed in this session (no key available). User is expected to run `bun run seed` with their own test key before closing PR #2. Recovery path exists via `--tag=<value> --cleanup` if the create path partially succeeds.

## Closed issues from Stage 0

- #2 — `.env.example` cleanup ✓
- #3 — `bun-types` pinned to 1.2.8 ✓
- #4 — root `dev` script wired ✓
- #5 — apps/api dev points at a real Hono server ✓

Issue #6 (SQLite path + single-process) remains open — belongs to Stage 3.

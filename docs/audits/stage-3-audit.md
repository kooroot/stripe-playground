# Stage 3 Audit

**Commits reviewed:** `d92f766` (API/DB), `69998b6` (webhook route), `fc749ba` (web + dev) on `stage/3-webhook-idempotency` (PR #15, merged as 09dca92).
**Fixes branch:** `fix/stage-3-audit` — MAJORs applied post-merge per user direction (user merged #15 before the second reviewer returned).
**Reviewed:** 2026-04-24
**Reviewers:** `superpowers:code-reviewer` (full) + `codex:codex-rescue` (6 focused questions on 4 critical files)
**Outcome:** 0 BLOCKER; 3 MAJORs fixed (2 codex-only, 1 code-reviewer-only), 2 MINORs fixed. Full reviewer dissent documented.

## Consolidated findings

### BLOCKER

None.

### MAJOR — fixed

| # | Location | Finding | Fix applied |
|---|---|---|---|
| M1 | `webhooks.ts:42` | **Codex**: `c.req.raw.text()` bypasses Hono's body cache; Hono itself explicitly warns against consuming `req.raw`. If any middleware touches the body first, signature verification silently fails. **code-reviewer**: "correct, no middleware today" — but the fragility is real and a future middleware add breaks webhooks invisibly. | Switched to `await c.req.text()` — Hono's cached reader preserves the bytes Stripe signed and is robust to Hono-friendly middleware. Comment updated. |
| M2 | `webhooks.ts:67,72` | **Codex MAJOR4**: idempotency gate ran BEFORE the HANDLED_EVENTS filter. Means unknown event types burn an event.id row; if a future stage adds a handler for that type, `stripe events resend` on the historic id silently no-ops. **code-reviewer N1**: argued the opposite — "keep as-is to prevent retroactive re-processing on deploy." Direct dissent. | Adopted codex. `stripe events resend` is an intentional backfill tool; the design should preserve the replay path, not block it. Filter moved BEFORE mark. Unknown events now 200 with no DB write. Comment explains the forward-compat reasoning. |
| M3 | `webhooks.ts:15` HANDLED_EVENTS | **Codex**: `payment_intent.requires_action` is in the shared `OrderStatusSchema` but absent from webhook dispatch — 3DS/authenticating intents leave the DB stuck at `processing` while the user is being challenged. code-reviewer missed this. | Added `payment_intent.requires_action` to `HandledEvent` / `HANDLED_EVENTS` / dispatch. Maps to `"requires_action"` in `orders.status`. |
| M4 | `packages/shared/src/index.ts:74` OrderStatusSchema | **code-reviewer**: `OrderStatusSchema` was missing `requires_capture`. Today unreachable via `automatic_payment_methods`, but `payments.ts` writes `intent.status` typed as `Stripe.PaymentIntent.Status` (which includes `requires_capture`). TS can't prove unreachability, and any future `capture_method: "manual"` PR would start 500-ing the GET /order endpoint silently. **codex 6**: "OK — 500 is right, but add `requires_capture` if manual capture is near-term." Soft agreement. | Added `requires_capture` to the enum. `db.ts:updateOrderStatus` tightened from `(status: string)` to `(status: OrderStatus)`, `insertOrder` likewise — the smuggling surface is now gone at compile time. |

### MINOR — fixed on this branch

| # | Location | Finding | Fix applied |
|---|---|---|---|
| m1 | `success.tsx` polling | **code-reviewer N2**: handler-error poisoning (documented at `webhooks.ts:82-88`) would leave orders stuck in `processing` with no backoff; the success-page poll spins forever. | Added `MAX_POLL_MS = 120_000` cap via `useMemo`/`useRef` elapsed-time check in `refetchInterval`. After 2 minutes non-terminal, poll stops and UI shows "webhook didn't land in 2 minutes — check the Stripe dashboard or server log". |
| m2 | `api/index.ts:25` | **code-reviewer N5**: root `GET /` returned `stage: 1` — stale since Stage 1. | Bumped to `stage: 3`. |
| m3 | `webhooks.ts:46` comment | **Codex 1**: "sync would fail under Bun" comment is too strong; Bun 1.2 has `node:crypto` shim and would likely work. constructEventAsync is still the correct choice for Web-Crypto-style runtimes, but the justification should be "preferred for Web Crypto portability", not "sync fails". | Comment rewritten. Default tolerance (300s) now passed explicitly for readability (codex suggestion). |
| m4 | `stage-3-observations.md` | **code-reviewer M2**: `GET /order/:orderId` has no auth. Prototype scope, so acceptable today — but if this pattern gets paste-copied into the main app integration it's a real cross-account data-exposure bug. | Added a "Security note — DO NOT paste this into the real integration as-is" section with the three changes required (session-bind ownership, reject non-owner, don't return `paymentIntentId` to unauthorized callers). |

### MINOR / NIT — filed as issues (deferred)

- **stage-3/A** — UNIQUE index on `orders(payment_intent_id)`: `CREATE UNIQUE INDEX IF NOT EXISTS` fails fast on pre-existing duplicates (practically impossible in this repo's write path, but defensive). Codex suggested a one-shot pre-check that names the offending rows. Defer: no real migration story for a prototype.
- **stage-3/B** — `updateOrderStatus` + handler dispatch are non-transactional. Known gap documented in `stage-3-observations.md`; the production fix is `db.transaction(() => { markEventProcessed(...); dispatch(...) })()`. Defer because the UI now has a 2-minute timeout that makes the observable failure visible.
- **stage-3/C** — Raw-body UTF-8 vs bytes. `c.req.text()` always UTF-8 decodes; Stripe emits pure-ASCII JSON so it's byte-identical in practice. For belt-and-braces, `new Uint8Array(await c.req.raw.arrayBuffer())` + `constructEventAsync` would be provably bytes-exact. Codex didn't flag. Not worth the ceremony in a prototype.

### NIT — not actioned

- `webhooks.ts:15` HANDLED_EVENTS typed `ReadonlySet<string>` with a literal cast; `as const` on the array would be cleaner ergonomically.
- `dispatch(event, db): Promise<void>` is synchronous today; the async return type keeps door open, not a bug.
- `dev:webhooks` start-ordering race between api bind and `stripe listen` backlog replay — documented in observations, not code-fixed (would add `--delay` noise).

## Reviewer convergence / disagreement

| Finding | code-reviewer | codex | Resolution |
|---|---|---|---|
| Raw body (`c.req.raw.text()` vs `c.req.text()`) | "correct, no middleware" | **MAJOR: brittle, bypasses cache** | Adopted codex. Hono's internal warning is definitive; code-reviewer's observation was scoped to today's middleware. |
| Idempotency ordering (mark-first vs filter-first) | **keep as-is (N1), prevents retroactive re-processing** | **MAJOR4: move filter BEFORE mark, preserves backfill path** | Adopted codex. `stripe events resend` is explicitly a backfill tool; blocking it was the wrong trade. |
| `payment_intent.requires_action` dispatch | not flagged | **MAJOR** | Adopted codex. code-reviewer's scope was React semantics + direct bugs; this is a Stripe-contract gap. |
| `requires_capture` in OrderStatusSchema | **MAJOR M1: add** | [OK] 6: 500 is right; add only if manual capture is near-term | Adopted code-reviewer. Cost is zero, future-proofing is real, and tightening `updateOrderStatus(status: OrderStatus)` only works if the enum covers the full PI status union. |
| Signature-verify 400 status codes | OK | OK | Converged. |
| Stablecoin-specific webhook types | not asked | [OK] — PI lifecycle is sufficient | Used as design confirmation; no change. |

Reviewer coverage was complementary again — code-reviewer stronger on React/TanStack semantics (N2 polling cap), type-system gaps (M1 enum), and documentation drift (M5); codex stronger on Stripe/Hono SDK specifics (raw body, requires_action, SDK version verification, forward-compat idempotency).

## Verification after fixes

- `bun --filter '*' typecheck` exits 0 across all workspaces.
- Runtime smoke: started api with `STRIPE_SECRET_KEY=sk_test_dummy STRIPE_WEBHOOK_SECRET=whsec_dummy`, confirmed `webhooks=on`; `curl` with missing signature → 400 `missing_signature`; `curl` with bogus signature → 400 `signature_mismatch`; `GET /api/payments/order/test` (nonexistent) → 404.
- E2E with real sk_test_ + stripe listen not run (no test-mode session this cycle).

### Manual test plan (addendum to `stage-3-observations.md`)

Before merge of the fix PR, the user should run the 10-scenario checklist in `docs/notes/stage-3-observations.md` — in particular:

1. **Idempotency ordering regression check.** `stripe trigger customer.created` (ignored type). Verify: `SELECT id FROM processed_events WHERE type='customer.created'` returns 0 rows. Previously it would have had 1.
2. **requires_action path.** Use 3DS challenge card `4000 0025 0000 3155`. Observe `orders.status` reaches `requires_action` briefly before transitioning to `succeeded` after the challenge completes.
3. **Polling cap.** Simulate a stuck webhook: stop `stripe listen` after the redirect lands but before the webhook forwards. Wait 2 minutes on `/checkout/success`. UI should show the timeout message.

## Closed issues

- #13 stage-2/B — `concurrently --kill-others-on-fail` instead of `-k` (landed in fc749ba on the Stage 3 merge).

# Stage 4 Audit

**Commits reviewed:** `dfcacd7` (API), `2870da0` (web + hook), `9378db5` (comparison doc) on `stage/4-checkout-vs-elements` (PR #20).
**Fixes commit:** `fix(stage-4): …` on the same branch — the PR is still open, so audit fixes land as additional commits before merge (returning to the pre-Stage-3 workflow).
**Reviewed:** 2026-04-24
**Reviewers:** `superpowers:code-reviewer` (full) + `codex:codex-rescue` (8 focused questions on 5 critical files).
**Outcome:** 0 BLOCKER after re-grading codex Q2 (see below); 4 MAJORs fixed + 3 MINORs fixed. Full dissent and re-grading documented.

## Consolidated findings

### BLOCKER

None after re-grading. **codex originally marked Q2 as BLOCKER**: `session.payment_intent: null` is a documented-nullable shape on Stripe's Session object, but in practice for `mode: "payment"` with standard PMs the PI is created synchronously at session creation and the null branch is unreachable. **Re-grade to MEDIUM**: prototype's card path never hits this. Logged with `sessionId / status / payment_status` if it ever fires; real fix (defer insertOrder until `payment_intent.created` lands) is deferred to Stage 5 where stablecoin flows will exercise the null path deliberately.

### MAJOR — fixed

| # | Location | Finding | Fix applied |
|---|---|---|---|
| M1 | `db.ts:113-126` updateOrderStatus | **code-reviewer**: UPDATE had no predicate. A late or re-delivered PI event (e.g. `stripe events resend` of an old `payment_intent.processing` after `succeeded` already transitioned) has a NEW event.id, so the idempotency gate doesn't stop it — the handler would downgrade the terminal order back to `processing` and the UI poll would hang 2 min. **codex Q6**: ordering "fine" (gate is per-id) but DID NOT flag the downgrade surface. Only code-reviewer caught this. | SQL WHERE clause now rejects writes to terminal rows except the one legitimate `succeeded → refunded` transition (`charge.refunded` handler). SQLite smoke-tested: `succeeded→processing` blocked, `succeeded→refunded` allowed, `refunded→processing` blocked. |
| M2 | `webhooks.ts:178-196` .expired | **code-reviewer**: gate was `{requires_payment_method, requires_confirmation}`. A user abandoning 3DS mid-challenge lands the order at `requires_action`; session expiry at 24h would then not touch it. Stripe DOES separately fire `payment_intent.canceled` for abandoned intents, but if delivery lags/fails this leaves orders permanently stuck. **codex Q5**: "leaving processing alone is correct; PI is authoritative for async" — same logic applies to requires_action (disagreed with code-reviewer). | Adopted code-reviewer as safety net: added `requires_action` to the expired-cancel gate. Both reviewers agree `processing` should stay alone (PI event is authoritative). The terminal-status guard from M1 absorbs the race if PI.canceled lands first. |
| M3 | `webhooks.ts` HANDLED_EVENTS / dispatch | **codex Q5**: for delayed-settlement PMs (stablecoin, BACS, SEPA), Stripe keeps the Session in `processing` and emits `checkout.session.async_payment_{succeeded,failed}` as the Checkout-side terminal signal. We were handling neither — async orders would stay `processing` forever on the Checkout surface, relying entirely on PI events. code-reviewer missed this. | Added both async events to HandledEvent / HANDLED_EVENTS / dispatch. Mapping: `async_payment_succeeded → "succeeded"`, `async_payment_failed → "failed"`. Terminal-status guard absorbs the race with PI events. |
| M4 (downgraded from codex Q2 BLOCKER) | `checkout.ts` null PI branch | Documented-nullable shape; runtime-unreachable for card. | Added `console.error` with `sessionId / status / payment_status` on the 500 branch so we can investigate if it ever fires. Observations doc flags Stage 5 as the likely place. |

### MINOR — fixed on this branch

| # | Location | Finding | Fix applied |
|---|---|---|---|
| m1 | `checkout.ts:92-94` successUrl | **codex Q7**: `success_url` didn't include Stripe's `{CHECKOUT_SESSION_ID}` template, even though the success page's `SearchSchema` already accepts `session_id`. Lost a first-class support/debug join key. | Changed `successUrl` to `?order_id=<uuid>&session_id={CHECKOUT_SESSION_ID}`. Stripe fills in the template on redirect. |
| m2 | `useOrderPoll.ts` doc | **codex Q8**: SPA-only `useMemo(Date.now)` anchor + component-remount reset not documented. **code-reviewer m1**: `timedOutRef` one-shot tripwire not documented. | Expanded the module-level comment block with three ASSUMPTIONS: SPA-only, remount resets budget, `timedOutRef` is one-shot. Future SSR migration path noted. |
| m3 | `docs/notes/stage-4-elements-vs-checkout.md` | **code-reviewer m2, m3**: reused-session URL drift + reused path not calling `sessions.retrieve`. Not prototype bugs today, but worth catalogue. | Added "Known limitations flagged during audit" section. |

### MINOR / NIT — not actioned

- **code-reviewer m4**: `order_closed` 409 branch is reachable via curl (not via UI with `crypto.randomUUID()` per mount). Confirmed as intentional guard, not dead code. No change needed.
- **code-reviewer m5**: `paymentIntentId: null` defensive branch log added as part of M4.
- **codex Q7 — `session_id` discard**: fixed as m1.
- **codex n1 (SearchSchema passthrough)**: harmless cosmetic — passthrough is already there. No change.
- **codex n2 (productName length)**: confirmed Stripe docs 250 char cap. Current `z.string().min(1).max(250)` is right.
- **codex n3 (metadata + client_reference_id redundancy)**: confirmed correct — three anchors serve three audiences (dashboard debug, PI-event path, session-event path).

## Reviewer convergence / disagreement

| Finding | code-reviewer | codex | Resolution |
|---|---|---|---|
| Terminal downgrade via stale PI event | **MAJOR (M1)** | confirmed-correct (Q6) — missed the downgrade surface | Adopted code-reviewer. SQL guard plus a `succeeded → refunded` carve-out. |
| `.expired` + `requires_action` | **MAJOR (M2): include in gate** | MEDIUM (Q5): "PI is authoritative, don't cancel processing" — ambiguous on requires_action | Adopted code-reviewer's safety-net framing; codex's logic applies to `processing` (which we leave alone) but the 3DS-abandon case benefits from a second safety net. Terminal guard absorbs the race. |
| `session.payment_intent: null` branch | m5 "future concern" | **BLOCKER (Q2)** — Stripe documented | Compromise: re-graded to MEDIUM, added logging. Proper fix deferred to Stage 5. |
| `checkout.session.async_payment_*` | not flagged | **MEDIUM (Q5)** | Adopted codex. Critical for stablecoin path. |
| `useOrderPoll` doc | m1 retry-button concern | Q8 SPA assumption concern | Merged both into a single ASSUMPTIONS comment block. |
| success_url session_id | not flagged | **LOW (Q7)** | Adopted codex. One-line change, real debuggability win. |
| Stripe SDK shape / SDK version | not deep-dived | confirmed-correct (Q1) with file:line grep to installed `stripe@22.1.0` + API `2026-04-22.dahlia` | Used as confirmation. |

Reviewer coverage pattern is now familiar: code-reviewer stronger on React hook semantics and general correctness surfaces (terminal downgrade was the big one neither agent caught in the initial design); codex stronger on Stripe SDK shape, docs-grounded event type coverage, and TanStack v5 specifics. Stage 4 confirmed the dual-review is pulling its weight — no single reviewer caught M1+M3 together, and codex's Q2 re-grade is a useful example of where "documented but unreachable" should be re-scoped rather than rubber-stamped.

## Verification after fixes

- `bun --filter '*' typecheck` exits 0 across all workspaces.
- Terminal-state SQL guard smoke-tested directly via sqlite3 CLI: `succeeded → processing` blocked, `succeeded → refunded` allowed, `refunded → processing` blocked.
- Runtime smoke: startup log shows `stage=4`, webhook route mounts when secret present, `POST /api/checkout/session` returns 400 Zod issues on empty body (confirmed pre-fix).
- E2E not run this cycle (no sk_test_ key).

### Manual test plan for the user before merge

See `docs/notes/stage-4-elements-vs-checkout.md` §Manual verification checklist. The additions specific to this fix commit:

1. **Terminal downgrade regression check (M1).** Complete a card payment via hosted Checkout (4242). Note the event ids in `stripe listen` output. Run `stripe events resend <evt_id_of_processing>` after the order reaches `succeeded`. Verify `updated_at` on the orders row does NOT change and status stays `succeeded`.
2. **3DS abandon (M2).** Use `4000 0025 0000 3155`, start the 3DS challenge, close the tab. Either wait 24h and observe `.expired` → order `canceled`, or `stripe trigger checkout.session.expired` to simulate.
3. **async_payment_* happy path (M3).** If dashboard test mode has stablecoin enabled, pay with USDC via hosted Checkout. Verify BOTH `checkout.session.completed` (payment_status: unpaid) and later `checkout.session.async_payment_succeeded` land, and the order transitions to `succeeded` via whichever fires first.
4. **session_id in success URL (m1).** On happy-path completion, inspect the URL bar on `/checkout-hosted/success` — should show both `order_id=<uuid>` AND `session_id=cs_test_...`.

## Closed issues

- None from prior stages — Stage 4 introduces no new "closes #" references.

# Stage 5 Audit

**Commits reviewed:** `c3e5f69` (refund API + UI), `e24c4a1` (jurisdiction memo + Tempo watch + integration checklist + stage-5 observations) on `stage/5-stablecoin-deep-dive` (PR #21).
**Fixes commit:** `fix(stage-5): ...` on the same branch — dual-audit fixes land as additional commits before merge.
**Reviewed:** 2026-04-24
**Reviewers:** `superpowers:code-reviewer` (full pass, 4 MINOR + 2 NIT) + `codex:codex-rescue` (8 focused questions, 1 MAJOR + 1 MEDIUM + 1 MINOR + 5 NIT).
**Outcome:** 0 BLOCKER; 1 MAJOR (codex Q8) + 1 MEDIUM (codex Q6) + 4 MINOR + 2 NIT fixed. Full dissent and resolution documented.

## Consolidated findings

### BLOCKER

None.

### MAJOR — fixed

| # | Location | Finding | Fix applied |
|---|---|---|---|
| M1 (codex Q8) | `docs/notes/stablecoin-accept-jurisdiction-decision.md:10,18,19,46` + `docs/notes/tempo-watch.md` | **codex** (web-verified via `tempo.xyz`, `docs.stripe.com/crypto/pay-with-crypto`, `circle.com/cpn/managed-payments`): three doc-accuracy issues. (a) Tempo mainnet is LIVE as of 2026-04-24, not "testnet only" as my original memo claimed. (b) "Circle Payments Network direct integration" needs qualification to "Circle CPN Managed Payments (fiat-operating merchant flow)" — the unqualified Payments Network phrase refers to wholesale FI settlement infrastructure, not a merchant product. (c) Stripe availability phrasing "US-only at time of writing" is too strong; Stripe's public rollout framing is "a limited set of US businesses." **code-reviewer m4** only flagged (a) as a softening-the-validator-framing issue, missing the mainnet-status error — classic codex-strong-on-docs-grounding dissent. | (a) Rewrote `tempo-watch.md` around mainnet-live premise, shifted "what to monitor" from "watch for mainnet launch" to "watch for merchant integration surface." Kept the institutional-validator framing as inference, not spec. (b) Renamed Option 2 in the jurisdiction memo + body to Circle CPN Managed Payments with the product qualification. (c) Changed "US-business-only" and "US-only constraint" to "limited set of US businesses" / "US-limited-rollout" throughout the memo. |

### MEDIUM — fixed

| # | Location | Finding | Fix applied |
|---|---|---|---|
| M2 (codex Q6) | `apps/api/src/routes/payments.ts:278` | **codex**: stale-local-state path. If `charge.refunded` webhook is missed, order row stays `succeeded`, Stripe's 24h idempotency-key cache expires, next retry would create a duplicate refund. Not a concurrent-race bug (Stripe's idempotency handles that) but a longer-horizon one. **code-reviewer** did not flag this — focused on the partial-refund collision case (m2) which is a different idempotency concern. | Added `stripe.refunds.list({ payment_intent, limit: 1 })` pre-check before `refunds.create`: if an existing refund exists for this PaymentIntent, return that instead of creating. Covers both the <24h concurrent-submit case (belt-and-braces with Stripe's idempotency key + `StripeIdempotencyError` catch that re-reads via list) AND the >24h stale case. No schema change. Trades one extra Stripe API call per refund request for application-level idempotence independent of Stripe's 24h cache. |

### MINOR — fixed on this branch

| # | Location | Finding | Fix applied |
|---|---|---|---|
| m1 (code-reviewer) | `apps/web/src/lib/useOrderPoll.ts:61-65` | **code-reviewer**: within-render inconsistency between `useMemo(Date.now, [restartKey])` (synchronous) and `useEffect(..., [restartKey])` that resets `timedOutRef`. On the render where restartKey flips, startedAt is fresh but timedOutRef still reads stale true. `timedOut` computation in the same render could flash the "timed out" banner for one frame. `refetchInterval` runs outside render so it's unaffected. **codex** did not flag this (Q4 only verified the closure recapture semantics, not the render-phase consistency). | Colocated the ref reset inside the `useMemo` itself: `useMemo(() => { timedOutRef.current = false; return Date.now(); }, [restartKey])`. Removed the `useEffect` and its import. Ref reset is now synchronous-with-restartKey and the one-frame banner flash is eliminated. |
| m2 (code-reviewer) | `apps/api/src/routes/payments.ts:283` | **code-reviewer**: idempotency key `order:<uuid>:refund` is single-use-per-order; works for full-refund scope but would silently collide on partial refunds if those land (two $5 refunds on a $20 order would either 409 or re-return the first refund). Requested flag as MINOR. | Added a comment on the idempotencyKey line noting the required suffix pattern (`:<amount>` or `:<client-uuid>`) when partial refunds land. Also threaded the same warning into `stage-5-observations.md` §"Known limitations." |
| m3 (code-reviewer) + Q7 (codex) | `apps/api/src/routes/payments.ts:298-309` | **code-reviewer m3**: shape-validation 500 branch has a UX gap (refund exists at Stripe; server returns 500; client shows error for an in-flight success). Both reviewers agreed the webhook + DB converge; only the client display is stale. **codex Q7**: recommended persisting and surfacing `refund.id` in the error/log path so reconciliation has a join key; explicitly warned against auto-calling `refunds.update/cancel` as a "fix." | Two changes. (a) Added `refundId` to both the `console.error` log object AND the 500 response body (new `error.refundId` field). (b) Documented the UX gap + log-line-as-alertable-signal in `stage-5-observations.md` §"Known limitations" — keeps the prototype's "fail loud" posture while giving production a clear alerting path. |
| m4 (code-reviewer) | `docs/notes/tempo-watch.md:13` | **code-reviewer**: "validator set biased toward regulated financial institutions" is inference, not sourced. | Subsumed by M1's rewrite of `tempo-watch.md`: validator-set claim now explicitly flagged as "inference rather than confirmed spec — verify at each quarterly check." |

### NIT — addressed

| # | Location | Finding | Fix applied |
|---|---|---|---|
| n1 (code-reviewer) | both success pages + `RefundPanel.tsx` | `restartKey: refundedAt ?? 0` used `Date.now()` as restart key with `0` as sentinel. Counter-based is cleaner (matches "bump" semantics, no Date.now allocation). | Switched to `const [refundKey, setRefundKey] = useState(0)` + `setRefundKey(k => k + 1)`. `RefundPanel.onRefundInitiated` signature simplified from `(at: number) => void` to `() => void`. |
| n2 (code-reviewer) | `payments.ts:297` | `satisfies Record<keyof RefundOrderResponse, unknown>` is defensive but redundant (zod catches mismatches at runtime). Taste call. | Left as-is. Compile-time typo protection at an inline literal is cheap insurance that does no harm. Code-reviewer explicitly rated this "taste call, leaving as-is is fine." |

### NIT — not actioned (codex)

- **codex Q1 (reason field NIT)**: optional `reason` parameter. Actioned alongside m3/Q7 — passing `reason: "requested_by_customer"` since refund is user-initiated; minor dashboard-semantics win.
- **codex Q2 (enum completeness)**: refund-status enum matches pinned API surface.
- **codex Q3 (charge.refund.updated)**: NOT handling `charge.refund.updated` is correct — deprecated event per Stripe docs. If we need refund-progress tracking, extend to `refund.updated` + `refund.failed`; out of prototype scope.
- **codex Q4 (refetchInterval closure)**: TanStack Query v5 re-reads the callback after rerender; no stale-closure risk. No change.
- **codex Q5 (one-extra-poll tick)**: theoretical one extra `GET /order` at worst, not a correctness bug. No change — could derive `awaitingTransition` directly from `order?.status !== "refunded"` but current effect-backed state is clearer.

## Reviewer convergence / disagreement

| Finding | code-reviewer | codex | Resolution |
|---|---|---|---|
| Tempo mainnet status | m4 (soften validator framing) | **Q8 MAJOR** (mainnet is LIVE, not testnet) | Adopted codex. code-reviewer saw the symptom (speculative validator claim), codex saw the deeper factual error (whole doc built on wrong premise). Rewrote `tempo-watch.md`. |
| Circle product naming | not flagged | **Q8 MAJOR** (qualify as CPN Managed Payments) | Adopted codex. Product-name precision matters when the memo is meant to guide a future decision. |
| Stripe availability phrasing | not flagged | **Q8 MAJOR** (rewrite as "limited set of US businesses") | Adopted codex. More accurate to Stripe's public positioning. |
| Stale-local-state >24h refund race | not flagged | **Q6 MEDIUM** | Adopted codex. `refunds.list` pre-check is a cheap app-level fix independent of Stripe's 24h idempotency cache. |
| Partial-refund idempotency collision | **m2** | Q6 touched adjacent ground (stale-state), didn't flag the partial-refund case specifically | Adopted code-reviewer's comment; prototype is full-refund only. |
| useOrderPoll render-phase timedOut flash | **m1** | not flagged (Q4/Q5 looked at closure + extra-tick, not render-phase) | Adopted code-reviewer. Colocated ref reset inside `useMemo`. |
| Shape-validation 500 gap | **m3** (UX gap; doc or graceful degrade) | **Q7 MINOR** (persist refund.id; log for reconciliation) | Converged answer: add `refundId` to both log and response body, document the UX gap. Neither reviewer recommended auto-cancel — both correctly flagged that as unsafe. |
| `satisfies` clause redundancy | **n2** (taste) | not flagged | Left as-is per code-reviewer's own "leaving as-is is fine." |
| refetchInterval closure | not flagged | Q4 verified re-capture | Confirmed-correct. |
| Stripe SDK `refunds.create` shape | not flagged | Q1 verified against installed v22.1.0 types | Confirmed-correct; added `reason` as a small polish. |
| enum completeness | not flagged | Q2 verified | Confirmed-correct. |
| webhook event choice | not flagged | Q3 verified `charge.refunded` (not deprecated `charge.refund.updated`) | Confirmed-correct. |

Reviewer coverage pattern (now confirmed across Stages 2–5): code-reviewer stronger on React hook semantics, component-level design, and general correctness surfaces (m1 render-phase inconsistency is a clean example — subtle timing bug neither agent caught in the initial design, and codex's Stripe-SDK focus wouldn't reach it); codex stronger on external-facts grounding (Q8 on doc accuracy, Q6 on Stripe API behavior beyond the obvious), Stripe SDK shape, and webhook-event taxonomy. Stage 5 is the fourth stage where dual-review pulled meaningful weight — Q8's mainnet-status correction is the highest-impact single catch across the whole audit cycle because it would have shipped wrong facts into an internal decision doc.

## Verification after fixes

- `bun --filter '*' typecheck` exits 0 across all workspaces (shared/api/web).
- E2E not run this cycle (no `sk_test_` key available to this agent). Manual E2E is in `docs/notes/stage-5-observations.md` §"Manual verification checklist" — the specific additions from this fix commit:

### Manual test plan for the user before merge

Walk `docs/notes/stage-5-observations.md` §"Manual verification checklist" end-to-end. The fix-commit-specific additions:

1. **`refunds.list` pre-check (Q6/M2).** Complete a refund (`refund` button on either success page). Note the refund id in the dashboard. Now manually `curl -X POST http://127.0.0.1:8787/api/payments/refund -H 'content-type: application/json' -d '{"orderId":"<same-uuid>"}'`. Expected: one 200 response echoing the SAME `refundId` as the original (from `refunds.list` pre-check, not a new refund created). Confirm in Stripe dashboard: only one refund row on the Payment.
2. **Render-phase timedOut (m1).** Mount the success page for an order, let the 2-minute poll budget expire (or reduce `MAX_POLL_MS` in a local edit for faster testing). Observe "webhook didn't land" banner. Click refund. The banner should NOT flash back into view for even one frame as the restartKey bump lands — it should clear immediately.
3. **Counter-based restartKey (n1).** DevTools React profiler on the success page before and after clicking refund. The prop passed to `useOrderPoll` should be a small integer (1 after first refund, 2 after second, etc.), not a millisecond epoch.
4. **Refund reason (codex Q1 polish).** After a successful refund, inspect the Refund object in the Stripe dashboard. `Reason` field should read "requested_by_customer."
5. **refundId on shape-validation failure (m3/Q7).** Hard to manually trigger without mocking (requires Stripe to return a novel `Refund.status`). Verify by code-review that the log line and 500 response both carry `refundId`.

## Closed issues

- None from prior stages — Stage 5 introduces no new "closes #" references.

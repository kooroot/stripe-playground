# Stage 0 Audit

**Commit reviewed:** `937b968` on `main`
**Reviewed:** 2026-04-24
**Reviewers:** `superpowers:code-reviewer` + `codex:codex-rescue` (parallel, independent)
**Outcome:** 0 BLOCKER, fixed all MAJOR on `stage/0-audit-fixes`, opened issues for MINOR/NIT.

## Consolidated findings

Dedup across reviewers, severity is the higher of the two when they disagree.

### BLOCKER
None.

### MAJOR — fixed on `stage/0-audit-fixes`

| # | Location | Finding | Fix applied |
|---|---|---|---|
| M1 | `tsconfig.base.json` | `types: ["bun-types"]` in the shared base silently narrows the ambient type surface for *every* extending workspace, disabling automatic `@types/*` discovery. Footgun for Stage 2 when `@types/react` lands. | Removed `types` from base; added narrowly-scoped `types: ["bun-types"]` to `apps/api/tsconfig.json` and `types: ["vite/client"]` to `apps/web/tsconfig.json`. |
| M2 | `apps/web/package.json` | Depended on `bun-types` via cross-workspace hoisting from `apps/api`. Fragile. | Web no longer needs `bun-types`; scoped to api only (see M1). Dep removed from base, not added to web. |
| M3 | root `package.json` + `tsconfig.json` | Root `tsc --noEmit` used root config whose `include` globbed across all workspaces. Ignored per-workspace `jsx`/`DOM` settings — Stage 2 `.tsx` would have typechecked against api's lib set. | Root `typecheck` now delegates: `bun --filter '*' typecheck`. Root `tsconfig.json` reduced to empty include (pure placeholder). Each workspace's `tsconfig.json` is authoritative for its files. Verified: `bun --filter '*' typecheck` exits 0 across all three workspaces. |
| M4 | `.gitignore` | `.env`, `.env.local`, `.env.*.local` miss `.env.development` / `.env.test` / `.env.production`. Real Stripe secrets could be committed via any non-listed variant. | Replaced with `.env*` + `!.env.example` exception. |
| M5 | design doc `Stage 2` — `payment_method_types: ['card', 'crypto']` | Stripe's current guidance prefers dynamic/automatic payment methods for Payment Element; hardcoding the method list is an explicit opt-out, not the default. | Rewrote Stage 2 to default to dynamic PMs + pinned API version; keeps manual `['card','crypto']` as a secondary experiment path for comparison. |
| M6 | design doc `Stage 2` — `amount+currency → new PaymentIntent per call` | Too stateless for retries; Stripe recommends reusing one PaymentIntent per cart/order. | Stage 2 now creates-or-reuses PaymentIntent keyed by server-generated `orderId`, stored in SQLite `orders`. `metadata.order_id` attached on every intent. |
| M7 | design doc — Accept-side US-business constraint underweighted | For a KR-based owner this is the single most important production finding and was buried in "Known Constraints." | Added top-level `## Accept-Side Jurisdiction (Critical)` section; Stage 5 deliverable now includes `docs/notes/stablecoin-accept-jurisdiction-decision.md` comparing Circle / Coinbase Commerce / US subsidiary. |
| M8 | design doc `Stage 5` — recurring stablecoin subscription | May be private-preview on Stripe; plan treats it as GA. | Stage 5 now gates recurring behind "if preview access enabled at execution time"; refund flow is the always-attempted deliverable. |
| M9 | design doc `Audit Protocol` — no rollback criterion, unclear issue routing | BLOCKER findings had no explicit "reopen stage" rule; MINOR/NIT routing was unspecified though session-agreed. | Rewrote Audit Protocol: branch + PR per stage, BLOCKER reopens stage, MAJOR fixes on branch before merge, MINOR/NIT become GitHub issues labeled `stage-N` + `minor`/`nit`, linked from PR. |

### MINOR — filed as GitHub issues (fix in later stage if at all)

| # | Location | Finding |
|---|---|---|
| m1 | `.env.example:1-11` | Duplicates publishable key (`STRIPE_PUBLISHABLE_KEY` + `VITE_STRIPE_PUBLISHABLE_KEY`); includes `STRIPE_WEBHOOK_SECRET` before Stage 3 needs it; uses cwd-relative SQLite path. |
| m2 | `apps/api/package.json` | `bun-types: latest` should be pinned to match Bun `1.2.8` runtime. |
| m3 | root `package.json` | `dev` script is `echo ...; exit 1` placeholder. Harmless but consider dropping until Stage 1 wires the real command. |
| m4 | `apps/api/package.json:6` | `bun run --hot src/index.ts` points at an empty file — running `bun --filter api dev` today starts a server with no routes. Placeholder is OK; note for Stage 1. |
| m5 | design doc + README | Specify "single local API process only" so SQLite idempotency dedupe state doesn't silently fork across launch modes; resolve DB path from `apps/api/.data/` not caller cwd. |

### NIT — wontfix / note-only

| # | Location | Finding | Disposition |
|---|---|---|---|
| n1 | `tsconfig.base.json` | `allowImportingTsExtensions: false` is the TS default. | Wontfix — explicit is fine. |
| n2 | `README.md` | Quickstart says "after Stage 1" but `bun run dev` at HEAD exits 1 (now does after M3 fix). | Noted. |
| n3 | `*/package.json` | `typescript: ^5.5.4` pinned in 4 places. | Wontfix — Bun workspace hoists correctly; consolidating is cosmetic. |

## Explicitly verified correct (coverage evidence)

From `superpowers:code-reviewer`:
- `bun install` + `bunx tsc --noEmit` both exit 0 at HEAD.
- Workspace naming (`api`, `web`, `@stripe-prototype/shared`) matches design and scopes correctly.
- Monorepo layout matches the "Repository Layout" section of the design doc.
- Dropping TS project references is sound for Bun-native: Bun reads `.ts` at runtime and resolves workspace `main`/`exports` pointing at `.ts` sources; `composite` + `.d.ts` emit would be dead weight.
- `.gitignore` covered env files, build outputs, TS incremental cache, `.vite/`, `.bun/`, `.DS_Store` before M4.
- `.env.example` contains only placeholder values (no real keys).
- Strict stance (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`) is appropriate.
- Hono raw-body webhook pattern and `bun:sqlite` idempotency approach correctly chosen.

## Reviewer disagreement

The two reviewers disagreed on the TS build topology:

- **codex** proposed converting to a TS solution file (`files: []`, `references` to each workspace) with `composite: true` and `tsc -b` orchestration. This matches standard TS project-references conventions.
- **code-reviewer** explicitly verified the current composite-less approach as sound for Bun-native execution.

**Resolution:** kept code-reviewer's approach (no `composite`, no project references) because Bun's runtime reads `.ts` sources directly and workspace `main`/`exports` point at `.ts`. But adopted codex's underlying concern — root typecheck ignoring workspace configs — by routing root `typecheck` through `bun --filter '*' typecheck` (see M3). Both reviewers end up satisfied.

## Verification after fixes

```
$ bun --filter '*' typecheck
web typecheck: Exited with code 0
@stripe-prototype/shared typecheck: Exited with code 0
api typecheck: Exited with code 0
```

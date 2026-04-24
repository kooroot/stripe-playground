# Tempo — watch note

Stage: 5 (monitoring-only doc; no code changes)
Status: watch quarterly
Last updated: 2026-04-24

## What Tempo is

Tempo is Stripe + Paradigm's stablecoin-native L1 blockchain, announced late 2025. Design goals per the Stripe Sessions 2025 announcement and subsequent writeups:

- EVM-compatible (Solidity, standard wallet tooling)
- Fee payment in stablecoins (USDC, etc.) instead of a native gas token
- Payments-specific throughput + finality targets (sub-second, "payment-grade")
- Operator/validator set biased toward regulated financial institutions rather than permissionless anon-validators

The pitch is: stablecoin payments on L1 today are hostage to the underlying chain's fee token (ETH, SOL, etc.) — users pay USDC-denominated prices but need to hold gas tokens. Tempo removes that friction and targets the merchant payments use case specifically.

## Why it's explicitly OUT OF SCOPE for this prototype

Per the project charter and re-confirmed during scope setting: this prototype is about **Stripe's hosted abstraction** for stablecoin (their `payment_method_types: ["stablecoin"]` / Stablecoin Accept surface). The underlying chain is an implementation detail that Stripe will choose — may be Tempo, may be existing L1/L2, may be both via routing.

Direct on-chain integration (running an EVM wallet, signing transactions with viem/alloy, managing gas, reading chain events) is a **different problem** with different operational surface (custody, key management, reorg handling, bridge risk). That's out of scope both for this prototype and for the main app's near-term roadmap.

## Why it's still worth watching

Two scenarios where Tempo becomes relevant:

1. **Stripe exposes Tempo as a settlement option on the merchant side.** If Stripe Stablecoin Accept in production lets merchants opt into "settle my USDC balance on Tempo" (faster finality, lower on-chain fees for payouts), we'd want to be early to it because our KR bank wiring cycle time directly trades against settlement-chain speed.
2. **Tempo becomes the default rail for a specific PM.** If, say, "pay with USDC" in the Stripe UI routes through Tempo by default (invisible to merchant, matters for webhook timing), our Stage 3 idempotency + Stage 4 async-payment-* handling may need to tolerate different timing envelopes. Unlikely to matter for the prototype, but worth knowing before the main-app integration ships to production load.

## What to monitor (quarterly)

Set a quarterly calendar reminder. Each check: skim these sources, update this file's "Observed status" section below, and flag anything that would reopen the jurisdiction decision memo.

- **Tempo docs / public status** — their developer site. Look for: mainnet launch date announcement, merchant-payment integrations list, any Stripe-specific tooling.
- **Stripe docs change log** — search for "Tempo". As of 2026-04-24, there is no documented merchant-facing Tempo surface.
- **Stripe Sessions recordings** — annual conference each spring. Tempo-specific sessions, jurisdiction expansions, merchant onboarding changes.
- **Paradigm research posts** — Tempo's technical lineage is Paradigm-incubated; their research blog is the leading edge of what the chain will actually ship.

## Triggers to escalate out of "watch" into "act"

- Tempo mainnet launches and Stripe announces a merchant-facing integration path (beyond testnet demos).
- Stripe Stablecoin Accept exposes a `chain` parameter or similar routing option in the `payment_method_options` — means merchants now have a choice to make per-transaction.
- Regulatory change: KR FIU issues guidance on virtual-asset settlement rails that makes L1 choice a compliance decision rather than a technical one.
- Competitor analysis: another payment processor (PayPal, Adyen, local KR PG) ships Tempo settlement and uses it as a marketing hook.

## What to NOT do

- **Don't pre-integrate with Tempo directly.** Wallet SDKs, chain clients, custom webhook parsing for on-chain events — all of that is the scope explicitly excluded from this prototype. If we need on-chain integration, that's a separate project with a separate scope doc, separate risk model, and separate legal sign-off.
- **Don't track Tempo token economics.** There's public speculation about a native fee token despite the stablecoin-gas pitch. Irrelevant to merchant integration; leave it to the protocol side.
- **Don't let Tempo dates slip the jurisdiction decision.** The jurisdiction memo's "defer until Q3 2026" is based on Stripe Stablecoin Accept expanding to KR, NOT on Tempo launching. If Stripe opens KR before Tempo matters, we ship.

## Observed status

Fill in during each quarterly check.

| Check date | Tempo status | Stripe KR stablecoin | Triggers fired? | Next check |
|---|---|---|---|---|
| 2026-04-24 | not launched (mainnet TBA, testnet only — per public roadmap) | US-only | none | 2026-07 |

## Cross-references

- `stablecoin-accept-jurisdiction-decision.md` — the parent decision this watch feeds into.
- `main-app-integration-checklist.md` — the paste-ready doc; explicitly does NOT reference Tempo so it stays stable across this watch's updates.

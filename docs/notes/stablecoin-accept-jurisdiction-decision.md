# Stablecoin accept — jurisdiction decision memo

Stage: 5 (decision doc; no code changes)
Status: **open — recommend "defer, revisit Q3 2026"**
Owner: kooroot
Last updated: 2026-04-24

## Problem

The main app wants to accept stablecoin (USDC) payments. Stripe's Stablecoin Accept (under the broader "Pay with Crypto" umbrella) is live but currently available to a limited set of US businesses — our KR-based entity can't enable it on a `sk_live_...` key. Test mode works for the prototype (this repo demonstrates the flow end-to-end) but production rollout needs a jurisdiction strategy.

## Options considered

The comparison below is the state-as-of 2026-04-24. Re-check before committing to an option — Stripe rolls out jurisdiction expansions quietly via dashboard toggles.

| Option | Time to ship | Monthly fixed cost | Variable fee | Compliance burden | Reversibility |
|---|---|---|---|---|---|
| **Stripe Stablecoin Accept via US subsidiary** | 6–10 months | $3–8k (legal + registered agent + US accounting) | 1.5% (announced Stripe rate) | High: US entity formation, state money-transmitter analysis, bank account, EIN, 1099s for team, separate tax filings | Low — can wind down US subsidiary but it's painful |
| **Circle CPN Managed Payments (fiat-operating merchant flow)** | 4–6 weeks | ~$0 (pay-per-transaction) | Circle's spread + on-chain gas | Medium: OFAC screening on every payout, Travel Rule compliance kicks in above thresholds | Medium — swap integration |
| **Coinbase Commerce direct integration** | 2–3 weeks | $0 | 1% flat | Low: Coinbase handles KYC/Travel Rule; we're a merchant | High — redirect checkout, swap is trivial |
| **Defer, revisit Q3 2026** | 0 | $0 | n/a | None | n/a |
| **Reverse-integrate: accept on-chain via EVM wallet (Alloy/viem)** | 8–12 weeks | $0 fixed, variable gas | gas + our own FX | High: custody, key mgmt, PCI-equivalent wallet ops, KR FIU reporting on virtual-asset flows | Low — written off as cost |

## Why each falls where it falls (detail)

### Option 1 — US subsidiary

**For.** Keeps the Stripe surface: same Checkout + PaymentIntent flows the prototype implements, same dashboard, same webhook shapes, reuses every line of code in this repo. Stablecoin becomes "just another payment method" alongside card. If the main app is US-customer-heavy, a US subsidiary unlocks more than just stablecoin (1099 issuance, ACH, etc.).

**Against.** Entity formation is ~$500–2k one-time (Stripe Atlas or equivalent). Ongoing: ~$2–5k/mo for US registered agent, bookkeeping, CPA, plus state-by-state money-transmitter-law analysis (not every state is friendly to payment-facilitator-adjacent structures even if we're just a merchant). A KR parent-US subsidiary arrangement also triggers KR FIU reporting obligations if funds move between them. Break-even vs Coinbase Commerce's 1% flat requires roughly $30–50k/mo in stablecoin volume — if the main app doesn't project that in year one, this option loses on pure economics before factoring risk.

### Option 2 — Circle CPN Managed Payments (fiat-operating merchant flow)

**For.** First-party USDC issuer; spread is tight; settles into a Circle Account we can wire to a KR bank. No redirect — we control the PM UI entirely. Circle Payments Network's "Managed Payments" product is the productized merchant surface (as distinct from the older Circle Accounts API or the network's wholesale settlement layer between FIs); verify the KR-entity onboarding path is open before committing.

**Against.** We become the PCI-equivalent entity for crypto — key management, failed-settlement handling, chargeback-equivalent dispute flows (which don't exist on-chain; customer support is on us). OFAC screening on every payout is required. Engineering surface is much larger than this prototype: we're essentially rebuilding a chunk of what Stripe gives us.

### Option 3 — Coinbase Commerce (direct)

**For.** Cheapest and fastest. 1% flat — Stripe's 1.5% plus the FX carve Coinbase takes on USDC→USD settlement can actually be higher than Coinbase's 1% net, depending on currency pair. Merchant-grade: Coinbase handles KYC/Travel Rule, we're just a merchant. Webhook shape is similar to Stripe's (event envelope + signature) so our Stage 3 idempotency/dispatch pattern ports directly.

**Against.** Redirect-based checkout (no native Elements embed), so UX is a step down from the main app's current card flow. Coinbase brand visible to user (might be a plus or minus). Settlement is T+2 USD or instant to a Coinbase account; wiring to KR bank adds 1–3 days + FX spread. Disputes non-existent — on-chain is final. Customer support is on us for "I sent the wrong amount" situations.

### Option 4 — Defer

**For.** Stripe's US-limited-rollout is time-limited. The team publicly said they're expanding jurisdictions "throughout 2026 and into 2027" (Sessions 2025 talk). If the main app can ship and succeed on card-only for 6–12 months, we may get Stripe Stablecoin Accept in KR without any of the above work.

**Against.** We're betting on Stripe's timeline, which is outside our control. If a competing merchant captures the "stablecoin accepted here" positioning, we're behind. Also — the whole reason we're looking at stablecoin is that some customer cohort (crypto-native users) prefers it; those users buy from whoever supports it NOW.

### Option 5 — On-chain direct (Alloy/viem, EVM wallet receiver)

Already explicitly out of scope per project charter. Listed here only so the memo is complete — custody liability alone makes this a non-starter for a team our size.

## Recommendation

**Defer until Q3 2026 (Option 4) with Coinbase Commerce (Option 3) as fallback.** Reasoning:

1. The prototype proves we have the operational surface to support stablecoin when Stripe Stablecoin Accept opens to KR — webhook dispatch, idempotency, terminal-state guards, refund flow all ported to stablecoin for free since Stripe abstracts the PM differences.
2. Watch the Stripe dashboard's "Payment method settings" monthly. The moment "Stablecoin" appears as a toggle on a KR-registered Stripe account, we ship it with ~2 weeks of web work.
3. If a real merchant opportunity demands stablecoin before then (e.g. a partner deal gated on it), take Coinbase Commerce as a 2–3 week detour. Engineering cost is bounded because the order-state backbone is already stablecoin-agnostic.
4. **Do not** start the US-subsidiary path unless the team simultaneously wants US-market expansion for reasons beyond stablecoin. The fixed cost is too high to justify purely for a payment method.

## Re-evaluation triggers

Reopen this memo and pick an option (not "defer") if any of the following fires:

- Stripe Stablecoin Accept announces KR availability — ship Option 1-equivalent (just toggle).
- A named customer/partner requires stablecoin payment as a deal condition — ship Option 3.
- Monthly crypto-payment inbound requests exceed ~50/mo from paying users — ship Option 3.
- US expansion becomes a company-level priority for reasons beyond payments — reopen Option 1 with stablecoin as a side benefit.
- Stripe announces sunset of their stablecoin product (unlikely but hedge).

## What this prototype gives us regardless of option

Independent of which option ships, the following is reusable:

- The order-state backbone (UUIDv4 orderId, webhook-authoritative terminal transitions, terminal-state SQL guard) is payment-method-agnostic.
- `processed_events` idempotency pattern ports to any webhook-firing payments processor (Coinbase Commerce's webhook envelope is close enough that the dispatch switch would just need new event-name mappings).
- The refund flow (Stage 5) won't port to on-chain direct (no refund concept on-chain without a counter-transfer), but ports cleanly to any centralized processor.
- `useOrderPoll` + `RefundPanel` UI components are processor-agnostic.

## Open questions for the next revisit

- Does Stripe Stablecoin Accept support refunds? (Prototype hasn't verified — card-4242 flow works end-to-end but stablecoin test mode in the dashboard is finicky.) Fill in during Stage 5 audit E2E if possible.
- Does `checkout.session.async_payment_succeeded` fire for stablecoin in all cases, or only when settlement truly delays? (Stage 4 handlers assume yes; verify.)
- What's the dispute/chargeback story on Stripe Stablecoin? Card has clear rails; stablecoin ledger is immutable. If "dispute" just means "Stripe refunds from our balance" with no cardholder counter-claim, that affects our fraud model.

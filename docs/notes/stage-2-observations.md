# Stage 2 — Observations (fill during hands-on testing)

Template for recording what the card + stablecoin flows actually feel like.
Filled in after running `bun run dev` + completing test payments.

## Environment

- `STRIPE_SECRET_KEY` = `sk_test_…` (fill once)
- `VITE_STRIPE_PUBLISHABLE_KEY` = `pk_test_…` (fill once)
- Stripe CLI: `stripe --version` = `1.40.7`
- Stripe API version pinned: `2026-04-22.dahlia`

## Dashboard prerequisites (one-time)

- [ ] Dashboard → Payment methods → enable cards (default)
- [ ] Dashboard → Payment methods → **Stablecoins and Crypto** → request
      access. May require business eligibility review even for test mode.
- [ ] After approval: test-mode "Stablecoins" card appears in Payment methods

## Card flow observations

Fill the table after running each test card through `/checkout`.

| Test card | Expected | Observed | Notes |
|---|---|---|---|
| `4242 4242 4242 4242` | succeed | | |
| `4000 0025 0000 3155` | 3DS challenge → succeed | | |
| `4000 0000 0000 9995` | insufficient funds | | |
| `4000 0000 0000 0002` | generic decline | | |
| `4000 0000 0000 0069` | expired card | | |

## Stablecoin flow observations

Fill after running USDC test on Polygon Amoy via the PaymentElement.

- [ ] MetaMask installed + Polygon Amoy testnet added
      (RPC `https://rpc-amoy.polygon.technology`, chainId 80002)
- [ ] Received test USDC from Circle faucet (20 USDC)
- [ ] Received POL from Polygon faucet (gas)

| Observation | Value |
|---|---|
| Time from "pay" click to Stripe event fired | |
| Time from Stripe event to on-chain confirmation | |
| On-chain tx hash | |
| Gas cost (POL) | |
| Stripe fee (test mode shows?) | |
| PaymentIntent object shape differences vs card | |
| UX: where does MetaMask popup vs Stripe-hosted wallet | |

## Reuse / retry observations

- [ ] Refresh `/checkout` mid-flow; observe new UUID orderId created
- [ ] Start payment, go back, re-submit same orderId → `status: "reused"`
- [ ] Force decline, retry same orderId → reused intent vs new?
- [ ] Switch amount mid-flow → expect 409 `order_mismatch`

## Experimental: manual `payment_method_types: ['card', 'crypto']`

Deferred to a follow-up branch. Compare against the automatic PMs baseline:
what methods show in the PaymentElement with manual vs automatic, and
whether the ordering/defaults match dashboard preferences.

## Open questions

- Stablecoin redirect target — does Stripe hand off to `crypto.stripe.com`
  (hosted wallet connect) or render an in-iframe prompt?
- Does the `payment_intent.succeeded` webhook fire at on-chain confirmation
  or at Stripe's internal acceptance? (Stage 3 will answer.)
- Refund path: UI / dashboard-only, and does USDC actually return to the
  original wallet in test mode?

## Non-obvious gotchas discovered

(record during testing)

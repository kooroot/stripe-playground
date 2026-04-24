# Stage 4 — Stripe Elements (inline) vs Checkout (hosted) comparison

Stage: 4
Branch: `stage/4-checkout-vs-elements`
Status: pre-audit (fill in observed rows during manual E2E)

## What this stage adds

- `apps/api/src/routes/checkout.ts` — `POST /api/checkout/session` creates a Stripe-hosted Checkout Session keyed by `orderId`, returns `{url, sessionId, paymentIntentId, orderId, status}`. Same order row, same webhook backbone as Elements.
- `apps/web/src/routes/checkout-hosted/{index,success,cancel}.tsx` — form → redirect to `checkout.stripe.com` → back to `/checkout-hosted/success?order_id=<uuid>` (poll) or `/checkout-hosted/cancel?order_id=<uuid>`.
- `apps/web/src/lib/useOrderPoll.ts` — shared hook extracting the polling+timeout logic used by both success pages (Elements + hosted).
- `checkout.session.completed` + `checkout.session.expired` added to webhook dispatch. Concurrent with `payment_intent.succeeded`; idempotency gate makes first-wins.
- `APP_BASE_URL` env var (defaults `http://127.0.0.1:5173`) feeds Session `success_url` / `cancel_url`.

## Comparison table

| Dimension | Elements (Stage 2+3) | hosted Checkout (Stage 4) |
|---|---|---|
| Where the user pays | inline on our origin | `checkout.stripe.com/c/pay/cs_test_...` |
| Client JS loaded | `@stripe/stripe-js` + `@stripe/react-stripe-js` (Elements) | none required (redirect) |
| Server call shape | `stripe.paymentIntents.create({amount, currency, automatic_payment_methods})` | `stripe.checkout.sessions.create({mode, line_items[], payment_intent_data})` |
| Client-facing secret | `client_secret` returned to browser, bound to PaymentElement | session `url` returned to browser, browser navigates away |
| Idempotency key | `order:<uuid>:create` (PI) | `order:<uuid>:checkout-session` |
| PaymentIntent created | yes, explicitly | yes, implicitly by Checkout (session.payment_intent) |
| Dynamic PMs | `automatic_payment_methods: { enabled: true }` | omit `payment_method_types` (dashboard-driven) |
| 3DS handling | SDK handles via `stripe.confirmPayment`'s redirect | Stripe-hosted page handles in full |
| Redirect back | `return_url` from `confirmPayment` → our `/checkout/success` | `success_url` / `cancel_url` → our `/checkout-hosted/{success,cancel}` |
| Order state authority | `payment_intent.*` webhooks | `payment_intent.*` OR `checkout.session.*` (first-wins) |
| Unique webhook events | — | `checkout.session.{completed,expired}` |
| Bundle size impact (web) | +Stripe.js (~80KB gz) | 0 on redirect path |
| Server code LOC | 200+ in payments.ts | 160 in checkout.ts |
| UX customization | full control (CSS, layout, PM list) | Stripe's Dashboard Appearance settings only |
| PCI scope | SAQ A (Stripe Elements iframe) | SAQ A (Stripe-hosted page) |
| Recovery from session expiry | N/A (PI persists) | new session (24h default TTL) |
| Mobile Apple/Google Pay | manual wiring via Payment Request Button | automatic (hosted page detects) |

## Webhook event ordering (capture during E2E)

For a synchronous card payment, Stripe fires BOTH `checkout.session.completed` and `payment_intent.succeeded`. Ordering is NOT guaranteed — Stripe explicitly says not to rely on it. First event to hit our endpoint claims the idempotency row and transitions the order; the second is a no-op duplicate because both converge on `succeeded`.

Table to fill with real timestamps during E2E testing (run `bun run dev:webhooks` and watch the CLI output):

| Flow | PI event 1 | PI event 2 | PI event 3 | Session event 1 | Session event 2 | First to land |
|---|---|---|---|---|---|---|
| Elements, card 4242 |   |   |   | n/a | n/a |   |
| Elements, card 3155 (3DS) |   |   |   | n/a | n/a |   |
| hosted, card 4242 |   |   |   |   | n/a |   |
| hosted, card 3155 (3DS) |   |   |   |   | n/a |   |
| hosted, session cancelled |   |   |   | — | `expired` (24h) | n/a |
| hosted, stablecoin (if test mode has it) |   |   |   |   | n/a |   |

Columns expected:
- PI events: some combo of `payment_intent.{requires_action, processing, succeeded}` or `{payment_failed, canceled}`
- Session events: `checkout.session.completed` for successful sessions, `checkout.session.expired` for TTL'd

## Observed differences (fill during hands-on testing)

- [ ] How does the hosted page handle 3DS vs Elements' inline redirect?
- [ ] Does stablecoin PM appear in hosted Checkout the same way as inline Elements?
- [ ] If the user dismisses the hosted page mid-3DS, does the session go to `expired` immediately or after TTL?
- [ ] How do `charge.succeeded` and `payment_intent.succeeded` interleave — are both emitted for both flows?
- [ ] For hosted flow, does `success_url` trigger even if the user closes the tab before returning?

## Design decisions

- **Both flows share the `orders` table.** No schema divergence. `payment_intent_data.metadata.order_id` on the Session call propagates `order_id` onto the underlying PI, so existing `payment_intent.*` handlers match on metadata regardless of surface.
- **`client_reference_id` as the secondary anchor.** Visible in the Stripe dashboard on the Session object and echoed on `checkout.session.*` events, handy for dashboard-based debugging.
- **No session reuse.** Idempotency key guarantees `sessions.create` with the same params returns the same Session — so browser refreshes and back-button → submit land on the same URL. Once the session is terminal (completed/expired), a new orderId is needed.
- **`payment_status === "paid"` is the only signal for auto-succeeded.** For async PMs (stablecoin, BACS), `checkout.session.completed` fires with `payment_status: "unpaid"` and the underlying PI is still `processing` — we defer the terminal transition to the PI event in that case.

## When to use which (learning goal)

Pick **hosted Checkout** when:
- PCI scope reduction is the priority (server never touches card input)
- You want Apple/Google Pay / Link / subscriptions with minimal wiring
- Your checkout page doesn't need custom branding beyond Appearance settings
- You're ok with a redirect (mobile apps might prefer)

Pick **Elements** when:
- Your checkout is embedded in a longer flow (cart, multi-step)
- You need inline validation or a custom layout
- You want the user to never leave your domain
- You're already managing payment state tightly (abandoned-cart emails, intent reuse across sessions)

For the main-app integration this prototype feeds into: default to **Elements for the primary flow** (inline UX is a revenue driver for the target persona), with **hosted Checkout as a fallback** for specific surfaces (e.g. Apple Pay-heavy paths, subscription upgrade).

## Manual verification checklist

1. **Setup** — `bun run dev:webhooks` (api + web + stripe listen). Confirm api log shows `stage=4 webhooks=on`.
2. **API shape** — `curl -X POST http://127.0.0.1:8787/api/checkout/session -d '{}' -H 'content-type: application/json'` returns 400 with Zod validation issues.
3. **Happy path (card)** —
   - http://127.0.0.1:5173/checkout-hosted → fill form → `go to Stripe Checkout`
   - Redirects to `checkout.stripe.com` → pay with `4242 4242 4242 4242`
   - Redirects back to `/checkout-hosted/success?order_id=<uuid>`
   - Page shows status transition `requires_payment_method` → `succeeded`
   - CLI `stripe listen` shows BOTH `checkout.session.completed` AND `payment_intent.succeeded`. Note which fires first.
4. **Idempotent re-submit** — back to hosted form with SAME orderId (via URL `?order_id=<uuid>` if you manually preserve it) or re-mount the route (new orderId — different test). The orderId is re-generated per mount, so true reuse is limited. The `status: "reused"` path is exercised when the user POSTs twice on the same mounted route before Stripe responds.
5. **Cancel** — start session → click Stripe's "Back" / close tab → land on `/checkout-hosted/cancel`. Leave 24h (or manually `stripe trigger checkout.session.expired`) → verify order status flips to `canceled` if still at `requires_payment_method`.
6. **Decline** — `4000 0000 0000 0002` in hosted checkout → Stripe shows decline → session stays open, PI gets `payment_failed` → order status `failed`.
7. **Async PM** — if stablecoin is enabled in dashboard test mode, pay via USDC → session `completed` with `payment_status: "unpaid"`, PI `processing` → later PI `succeeded` → order `succeeded`.
8. **Dashboard visibility** — confirm Session object in Stripe dashboard test mode shows `client_reference_id: <our uuid>` and `metadata.order_id: <our uuid>`.
9. **Cross-flow isolation** — run Elements flow and hosted flow back-to-back with different orderIds; verify each lands in its own `orders` row with distinct `payment_intent_id`s.

## Outstanding questions for Stage 4 audit

- Should the hosted-session `status: "reused"` return path also verify the prior session is still `open` (not `complete`/`expired`)? Current code 409s on terminal order status, but an `open` session for a non-terminal order just idempotently returns the same URL — which could be the WRONG URL if we changed the `success_url` between calls (we don't today, but fragile).
- `/checkout-hosted/cancel` does not mutate the DB. The `checkout.session.expired` handler does, but only after 24h. Is there a case where we should eagerly mark canceled on cancel_url hit? (Answer: no — user might still complete from the Stripe page if they reopen; only the session going terminal is authoritative.)
- Bundle-size claim in the comparison table ("hosted = 0 on redirect path"): verify with `bun --filter web build` (not done yet — Stage 4 doesn't wire prod build).

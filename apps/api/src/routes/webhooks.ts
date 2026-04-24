import { Hono } from "hono";
import Stripe from "stripe";
import type { Db } from "../db";

// Maps Stripe event -> next order status. Any event not listed is ignored
// (with a 200 so Stripe doesn't retry). Charge refunds carry the intent id,
// not the order id, so the handler looks up the order via getOrderByIntent.
//
// `payment_intent.requires_action` IS handled — it's the 3DS/authenticating
// transition surface. Omitting it would leave the DB status stuck at
// `processing` while the user is being challenged, and the success-page poll
// would show stale state. The shared OrderStatusSchema already has a slot
// for "requires_action"; this wires the webhook end of that contract.
type HandledEvent =
  | "payment_intent.succeeded"
  | "payment_intent.payment_failed"
  | "payment_intent.processing"
  | "payment_intent.requires_action"
  | "payment_intent.canceled"
  | "charge.refunded"
  | "checkout.session.completed"
  | "checkout.session.expired"
  | "checkout.session.async_payment_succeeded"
  | "checkout.session.async_payment_failed";

const HANDLED_EVENTS: ReadonlySet<string> = new Set<HandledEvent>([
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "payment_intent.processing",
  "payment_intent.requires_action",
  "payment_intent.canceled",
  "charge.refunded",
  // Stage 4: hosted-Checkout-specific events. They race with the underlying
  // payment_intent.* events, but the idempotency gate (per event.id) plus
  // the terminal-status guard in db.updateOrderStatus make the combined flow
  // safe — first wins and late arrivals can't downgrade.
  "checkout.session.completed",
  "checkout.session.expired",
  // async_payment_* fire for delayed settlement PMs (stablecoin, BACS, SEPA)
  // after `checkout.session.completed` already landed with payment_status:
  // "unpaid". These ARE the terminal signals for async Checkout flows, not
  // the PI events — though PI events also fire and converge on the same
  // status via the terminal guard.
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
]);

export function webhookRoutes(deps: {
  stripe: Stripe;
  db: Db;
  webhookSecret: string;
}): Hono {
  const app = new Hono();

  app.post("/stripe", async (c) => {
    // Signature verify MUST run on the body bytes Stripe signed. We use
    // `c.req.text()` (Hono's cached reader) rather than `c.req.raw.text()`:
    // Hono's own error message explicitly warns against consuming
    // `c.req.raw` directly, and the cached path is robust to another
    // middleware having touched the body via Hono helpers first. JSON
    // re-serialization (c.req.json()) would still fail the HMAC — text-mode
    // preserves the bytes.
    const sig = c.req.header("stripe-signature");
    if (!sig) {
      return c.json(
        { ok: false, error: { type: "missing_signature" } },
        400,
      );
    }
    const rawBody = await c.req.text();

    let event: Stripe.Event;
    try {
      // constructEventAsync uses Web Crypto (SubtleCrypto), preferred for
      // Web-Crypto-style runtimes including Bun. Default tolerance is 300s;
      // passed explicitly here for readability of the retry window.
      event = await deps.stripe.webhooks.constructEventAsync(
        rawBody,
        sig,
        deps.webhookSecret,
        300,
      );
    } catch (err) {
      // Never echo err.message: signature errors can include timing details
      // an attacker probing the endpoint would use to calibrate.
      const code =
        err instanceof Stripe.errors.StripeSignatureVerificationError
          ? "signature_mismatch"
          : "invalid_payload";
      return c.json({ ok: false, error: { type: code } }, 400);
    }

    // Filter-first: only record events we actually dispatch. Recording
    // unknown types would burn their event.id, and a later stage that adds
    // a handler for that type could never backfill via `stripe events
    // resend` — the idempotency gate would silently skip the replay. So
    // ignored events return 200 with NO side effects (Stripe still stops
    // retrying because 2xx).
    if (!HANDLED_EVENTS.has(event.type)) {
      return c.json({ ok: true, ignored: event.type });
    }

    // Idempotency gate for handled types: Stripe retries on any non-2xx and
    // can also re-deliver on network blips even after a 2xx. `stripe events
    // resend` from the CLI also lands here. First-delivery only.
    const firstDelivery = deps.db.markEventProcessed(event.id, event.type);
    if (!firstDelivery) {
      return c.json({ ok: true, duplicate: true });
    }

    try {
      await dispatch(event, deps.db);
      return c.json({ ok: true });
    } catch (err) {
      // DB write failure is the only realistic error path here. The event id
      // is already in processed_events, so a retry from Stripe would be
      // treated as a duplicate and never re-run the handler. For this
      // prototype that's acceptable (we'll notice the orphaned status in
      // dashboard/CLI during manual verification); a production build would
      // wrap markEventProcessed + dispatch in a single transaction and roll
      // both back on failure.
      console.error(
        `[webhook] dispatch failed for event ${event.id} (${event.type})`,
        err,
      );
      return c.json({ ok: false, error: { type: "handler_error" } }, 500);
    }
  });

  return app;
}

async function dispatch(event: Stripe.Event, db: Db): Promise<void> {
  switch (event.type) {
    case "payment_intent.succeeded":
    case "payment_intent.processing":
    case "payment_intent.requires_action":
    case "payment_intent.canceled":
    case "payment_intent.payment_failed": {
      const pi = event.data.object as Stripe.PaymentIntent;
      const orderId = pi.metadata?.order_id;
      if (!orderId) {
        // Intents created outside our checkout route (e.g. test dashboard
        // triggers without metadata.order_id) have nothing to transition.
        // Don't throw — the event is genuinely unrelated to our orders.
        return;
      }
      const nextStatus =
        event.type === "payment_intent.succeeded"
          ? "succeeded"
          : event.type === "payment_intent.payment_failed"
            ? "failed"
            : event.type === "payment_intent.canceled"
              ? "canceled"
              : event.type === "payment_intent.requires_action"
                ? "requires_action"
                : "processing";
      db.updateOrderStatus(orderId, nextStatus);
      return;
    }
    case "charge.refunded": {
      const charge = event.data.object as Stripe.Charge;
      const pi =
        typeof charge.payment_intent === "string"
          ? charge.payment_intent
          : (charge.payment_intent?.id ?? null);
      if (!pi) return;
      const order = db.getOrderByIntent(pi);
      if (!order) return;
      db.updateOrderStatus(order.order_id, "refunded");
      return;
    }
    case "checkout.session.completed": {
      // Fires when the hosted session hits `status: "complete"`. For
      // mode: "payment" that's `payment_status: "paid"` for synchronous PMs,
      // or `unpaid` + a still-processing PI for async PMs (stablecoin,
      // bank debits, etc.). Only flip to "succeeded" when the session says
      // paid; otherwise defer to the payment_intent.* events.
      const session = event.data.object as Stripe.Checkout.Session;
      const orderId =
        session.metadata?.order_id ?? session.client_reference_id ?? null;
      if (!orderId) return;
      if (session.payment_status === "paid") {
        db.updateOrderStatus(orderId, "succeeded");
      }
      return;
    }
    case "checkout.session.expired": {
      // 24h default expiry with no completed payment. Terminal for the
      // session, but we don't auto-flip to "canceled" for every state: if
      // the PI is processing (async PM still resolving), the PI events are
      // authoritative and the session expiry is informational. Cancel
      // eagerly only for states that represent "user never finished":
      //
      //   requires_payment_method  — never entered payment details
      //   requires_confirmation    — entered but didn't submit
      //   requires_action          — started 3DS challenge and walked away
      //
      // `requires_action` is included as a safety net: Stripe separately
      // fires `payment_intent.canceled` for abandoned 3DS intents, but if
      // that delivery ever lags or gets lost, this guarantees the order
      // doesn't stay stuck. The terminal-status guard in
      // db.updateOrderStatus prevents double-writes if PI.canceled lands
      // first.
      const session = event.data.object as Stripe.Checkout.Session;
      const orderId =
        session.metadata?.order_id ?? session.client_reference_id ?? null;
      if (!orderId) return;
      const order = db.getOrder(orderId);
      if (!order) return;
      if (
        order.status === "requires_payment_method" ||
        order.status === "requires_confirmation" ||
        order.status === "requires_action"
      ) {
        db.updateOrderStatus(orderId, "canceled");
      }
      return;
    }
    case "checkout.session.async_payment_succeeded":
    case "checkout.session.async_payment_failed": {
      // For delayed-settlement PMs (stablecoin, BACS, SEPA), these are the
      // terminal signals for the Checkout surface — the session stays at
      // `status: processing` until they fire. PI events also fire in
      // parallel; the terminal-status guard absorbs the race.
      const session = event.data.object as Stripe.Checkout.Session;
      const orderId =
        session.metadata?.order_id ?? session.client_reference_id ?? null;
      if (!orderId) return;
      const nextStatus =
        event.type === "checkout.session.async_payment_succeeded"
          ? "succeeded"
          : "failed";
      db.updateOrderStatus(orderId, nextStatus);
      return;
    }
    default:
      return;
  }
}

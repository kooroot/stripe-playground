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
  | "charge.refunded";

const HANDLED_EVENTS: ReadonlySet<string> = new Set<HandledEvent>([
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "payment_intent.processing",
  "payment_intent.requires_action",
  "payment_intent.canceled",
  "charge.refunded",
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
    default:
      return;
  }
}

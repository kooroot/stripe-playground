import { Hono } from "hono";
import Stripe from "stripe";
import type { Db } from "../db";

// Maps Stripe event -> next order status. Any event not listed is ignored
// (with a 200 so Stripe doesn't retry). Charge refunds carry the intent id,
// not the order id, so the handler looks up the order via getOrderByIntent.
type HandledEvent =
  | "payment_intent.succeeded"
  | "payment_intent.payment_failed"
  | "payment_intent.processing"
  | "payment_intent.canceled"
  | "charge.refunded";

const HANDLED_EVENTS: ReadonlySet<string> = new Set<HandledEvent>([
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "payment_intent.processing",
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
    // Signature verify MUST run on the unparsed byte stream Stripe signed.
    // c.req.raw is the underlying Fetch Request — .text() reads the body
    // exactly once without JSON-parsing first. Hono's c.req.json() would
    // consume and re-serialize, which changes the bytes and fails the HMAC.
    const sig = c.req.header("stripe-signature");
    if (!sig) {
      return c.json(
        { ok: false, error: { type: "missing_signature" } },
        400,
      );
    }
    const rawBody = await c.req.raw.text();

    let event: Stripe.Event;
    try {
      // constructEventAsync uses Web Crypto (SubtleCrypto), which Bun supports
      // natively. The sync variant requires Node's crypto module and would
      // fail under Bun's default runtime.
      event = await deps.stripe.webhooks.constructEventAsync(
        rawBody,
        sig,
        deps.webhookSecret,
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

    // Idempotency gate: Stripe retries on any non-2xx and can also re-deliver
    // on network blips even after a 2xx. Events the CLI `stripe events resend`
    // also land here. If we've seen this id, acknowledge without side effects.
    const firstDelivery = deps.db.markEventProcessed(event.id, event.type);
    if (!firstDelivery) {
      return c.json({ ok: true, duplicate: true });
    }

    if (!HANDLED_EVENTS.has(event.type)) {
      // Unknown event types must still return 2xx — otherwise Stripe keeps
      // retrying for up to 3 days and the dashboard fills with failures.
      return c.json({ ok: true, ignored: event.type });
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

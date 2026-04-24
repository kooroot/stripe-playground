import { Hono } from "hono";
import Stripe from "stripe";
import {
  CreateCheckoutSessionRequestSchema,
  type CreateCheckoutSessionResponse,
} from "@stripe-prototype/shared";
import type { Db } from "../db";

// Stage 4 parallels the Stage 2 PaymentIntent route but produces a Stripe-hosted
// Checkout Session URL instead of a clientSecret. The orders table is the same,
// so every webhook transition (succeeded / failed / refunded) flows through the
// existing `metadata.order_id` path regardless of which checkout surface the
// user came from.
//
// Design choices:
// - ad-hoc `price_data` (no Price object dependency) — keeps the prototype
//   self-contained whether or not `bun run seed` has been run
// - `payment_intent_data.metadata.order_id` propagates to the PI so Stage 3
//   webhook handlers recognize it with no changes
// - `client_reference_id: orderId` as a secondary anchor (visible in dashboard,
//   surfaces on `checkout.session.*` events)
// - Idempotency-Key `order:<orderId>:checkout-session` so repeated submits
//   return the SAME session (URL stays stable across browser reloads)
export function checkoutRoutes(deps: {
  stripe: Stripe;
  db: Db;
  appBaseUrl: string;
}): Hono {
  const app = new Hono();

  app.post("/session", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CreateCheckoutSessionRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          ok: false,
          error: {
            type: "validation",
            issues: parsed.error.issues.map((i) => ({
              path: i.path.join("."),
              message: i.message,
            })),
          },
        },
        400,
      );
    }
    const { orderId, amount, currency, productName } = parsed.data;

    try {
      const existing = deps.db.getOrder(orderId);
      if (existing) {
        if (existing.amount !== amount || existing.currency !== currency) {
          return c.json(
            {
              ok: false,
              error: {
                type: "order_mismatch",
                message:
                  "amount/currency differs from the original request for this orderId",
              },
            },
            409,
          );
        }
        // Terminal statuses mean the order is already paid / cancelled /
        // refunded — don't spin up another session. The Elements route has
        // the same check, so the behavior is consistent across surfaces.
        const terminal = new Set([
          "succeeded",
          "failed",
          "refunded",
          "canceled",
        ]);
        if (terminal.has(existing.status)) {
          return c.json(
            {
              ok: false,
              error: {
                type: "order_closed",
                message: `orderId already terminal (db status: ${existing.status})`,
              },
            },
            409,
          );
        }
      }

      // success_url uses our order_id anchor (not Stripe's
      // {CHECKOUT_SESSION_ID} template) so the success page polls the same
      // GET /api/payments/order/:orderId endpoint as the Elements flow.
      const successUrl = `${deps.appBaseUrl}/checkout-hosted/success?order_id=${orderId}`;
      const cancelUrl = `${deps.appBaseUrl}/checkout-hosted/cancel?order_id=${orderId}`;

      let session: Stripe.Checkout.Session;
      try {
        session = await deps.stripe.checkout.sessions.create(
          {
            mode: "payment",
            // Omit payment_method_types to get dashboard-driven dynamic PMs —
            // same decision as Stage 2's automatic_payment_methods on PI.
            line_items: [
              {
                quantity: 1,
                price_data: {
                  currency,
                  unit_amount: amount,
                  product_data: { name: productName },
                },
              },
            ],
            client_reference_id: orderId,
            metadata: { order_id: orderId },
            // Propagate order_id onto the underlying PaymentIntent so the
            // existing Stage 3 webhook handlers can tie PI events back to
            // the right order with no code changes.
            payment_intent_data: {
              metadata: { order_id: orderId },
            },
            success_url: successUrl,
            cancel_url: cancelUrl,
          },
          { idempotencyKey: `order:${orderId}:checkout-session` },
        );
      } catch (err) {
        if (
          err instanceof Stripe.errors.StripeIdempotencyError ||
          (err instanceof Stripe.errors.StripeError &&
            err.code === "idempotency_key_in_use")
        ) {
          return c.json(
            {
              ok: false,
              error: { type: "in_flight" },
            },
            409,
          );
        }
        throw err;
      }

      // session.payment_intent is a string (unexpanded) for mode: "payment".
      // If we ever move to expansion, coerce to id.
      const paymentIntentId =
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : (session.payment_intent?.id ?? null);

      if (!session.url) {
        return c.json(
          { ok: false, error: { type: "stripe_unexpected" } },
          500,
        );
      }

      // First-time insert uses the PI id pulled off the session. On repeat
      // submits INSERT OR IGNORE is a no-op and we return `status: "reused"`.
      // Note: this is different from the Stage 2 PI flow's use of `reused`
      // (same intent handed back); here `reused` means same session URL.
      let status: "new" | "reused";
      if (existing) {
        status = "reused";
      } else if (paymentIntentId) {
        deps.db.insertOrder({
          order_id: orderId,
          payment_intent_id: paymentIntentId,
          amount,
          currency,
          status: "requires_payment_method",
        });
        status = "new";
      } else {
        // Defensive: mode=payment should always populate payment_intent.
        // If Stripe ever changes that, we'd be writing a null into a NOT NULL
        // column — fail loud instead of poisoning the row.
        return c.json(
          { ok: false, error: { type: "stripe_missing_intent" } },
          500,
        );
      }

      const res: CreateCheckoutSessionResponse = {
        url: session.url,
        sessionId: session.id,
        paymentIntentId,
        orderId,
        status,
      };
      return c.json(res);
    } catch (err) {
      if (err instanceof Stripe.errors.StripeError) {
        const httpStatus =
          err instanceof Stripe.errors.StripeConnectionError ? 503 : 502;
        return c.json(
          {
            ok: false,
            error: {
              type: err.type,
              code: err.code ?? null,
              requestId: err.requestId ?? null,
            },
          },
          httpStatus,
        );
      }
      return c.json({ ok: false, error: { type: "unknown" } }, 500);
    }
  });

  return app;
}

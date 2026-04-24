import { Hono } from "hono";
import Stripe from "stripe";
import {
  CreatePaymentIntentRequestSchema,
  type CreatePaymentIntentResponse,
} from "@stripe-prototype/shared";
import type { Db } from "../db";

// Statuses where the stored PaymentIntent can be handed back to the browser
// for another confirm attempt. NOTE: `processing` is deliberately NOT here —
// Stripe rejects a second confirm on a processing intent, and a client-side
// retry with the same clientSecret errors. That status returns a dedicated
// "processing" response with clientSecret=null so the UI can render a wait
// page instead of re-instantiating PaymentElement.
//
// `requires_capture` is also excluded: today the create call uses
// automatic_payment_methods (i.e. automatic capture), so this status is
// unreachable. If a future stage opts into capture_method: "manual", add
// `requires_capture` here.
const REUSABLE_STATUSES = new Set<Stripe.PaymentIntent.Status>([
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
]);

function shapeReuseResponse(
  orderId: string,
  pi: Stripe.PaymentIntent,
): CreatePaymentIntentResponse {
  if (pi.status === "processing") {
    return {
      clientSecret: null,
      paymentIntentId: pi.id,
      orderId,
      status: "processing",
    };
  }
  // Caller must have gated on REUSABLE_STATUSES before calling this branch.
  return {
    clientSecret: pi.client_secret as string,
    paymentIntentId: pi.id,
    orderId,
    status: "reused",
  };
}

export function paymentsRoutes(deps: { stripe: Stripe; db: Db }): Hono {
  const app = new Hono();

  app.post("/intent", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CreatePaymentIntentRequestSchema.safeParse(body);
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
    const { orderId, amount, currency } = parsed.data;

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

        const retrieved = await deps.stripe.paymentIntents.retrieve(
          existing.payment_intent_id,
        );
        if (retrieved.status === "processing") {
          deps.db.updateOrderStatus(orderId, retrieved.status);
          return c.json(shapeReuseResponse(orderId, retrieved));
        }
        if (REUSABLE_STATUSES.has(retrieved.status) && retrieved.client_secret) {
          deps.db.updateOrderStatus(orderId, retrieved.status);
          return c.json(shapeReuseResponse(orderId, retrieved));
        }
        return c.json(
          {
            ok: false,
            error: {
              type: "order_closed",
              message: `orderId already terminal (stripe status: ${retrieved.status})`,
            },
          },
          409,
        );
      }

      // New order path. Two browser tabs can both read "no existing order"
      // and race into create with the same idempotency key. Stripe
      // deduplicates the intent object itself, but returns
      // `idempotency_key_in_use` for the losing concurrent request. Catch
      // that and re-read the DB (the winning request will have committed
      // its row by the time we retry).
      let intent: Stripe.PaymentIntent;
      try {
        intent = await deps.stripe.paymentIntents.create(
          {
            amount,
            currency,
            automatic_payment_methods: { enabled: true },
            metadata: { order_id: orderId },
          },
          { idempotencyKey: `order:${orderId}:create` },
        );
      } catch (err) {
        if (
          err instanceof Stripe.errors.StripeIdempotencyError ||
          (err instanceof Stripe.errors.StripeError &&
            err.code === "idempotency_key_in_use")
        ) {
          await new Promise((r) => setTimeout(r, 150));
          const winner = deps.db.getOrder(orderId);
          if (!winner) {
            return c.json(
              { ok: false, error: { type: "race_unresolved" } },
              503,
            );
          }
          const reread = await deps.stripe.paymentIntents.retrieve(
            winner.payment_intent_id,
          );
          deps.db.updateOrderStatus(orderId, reread.status);
          return c.json(shapeReuseResponse(orderId, reread));
        }
        throw err;
      }

      if (!intent.client_secret) {
        return c.json(
          { ok: false, error: { type: "stripe_unexpected" } },
          500,
        );
      }

      deps.db.insertOrder({
        order_id: orderId,
        payment_intent_id: intent.id,
        amount,
        currency,
        status: intent.status,
      });

      const res: CreatePaymentIntentResponse = {
        clientSecret: intent.client_secret,
        paymentIntentId: intent.id,
        orderId,
        status: "new",
      };
      return c.json(res);
    } catch (err) {
      if (err instanceof Stripe.errors.StripeError) {
        const status =
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
          status,
        );
      }
      return c.json({ ok: false, error: { type: "unknown" } }, 500);
    }
  });

  return app;
}

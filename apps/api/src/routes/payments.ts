import { Hono } from "hono";
import Stripe from "stripe";
import {
  CreatePaymentIntentRequestSchema,
  type CreatePaymentIntentResponse,
} from "@stripe-prototype/shared";
import type { Db } from "../db";

// PaymentIntent statuses that are still "mutable" — we can return their
// client_secret to the browser for another attempt. Terminal statuses
// force a new PaymentIntent (same orderId is already collected/canceled).
const REUSABLE_STATUSES = new Set<Stripe.PaymentIntent.Status>([
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
  "processing",
]);

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
        // Amount/currency must match — switching them mid-flow is a bug.
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
        if (REUSABLE_STATUSES.has(retrieved.status) && retrieved.client_secret) {
          deps.db.upsertOrder({
            order_id: orderId,
            payment_intent_id: retrieved.id,
            amount,
            currency,
            status: retrieved.status,
          });
          const res: CreatePaymentIntentResponse = {
            clientSecret: retrieved.client_secret,
            paymentIntentId: retrieved.id,
            orderId,
            status: "reused",
          };
          return c.json(res);
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

      // New order — create a PaymentIntent with dynamic payment methods
      // (the design-doc baseline). Idempotency-Key ties retries of the
      // same orderId to the same Stripe-side intent.
      const intent = await deps.stripe.paymentIntents.create(
        {
          amount,
          currency,
          automatic_payment_methods: { enabled: true },
          metadata: { order_id: orderId },
        },
        { idempotencyKey: `order:${orderId}:create` },
      );

      if (!intent.client_secret) {
        // Shouldn't happen unless Stripe shape changes; fail loudly.
        return c.json(
          { ok: false, error: { type: "stripe_unexpected" } },
          500,
        );
      }

      deps.db.upsertOrder({
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

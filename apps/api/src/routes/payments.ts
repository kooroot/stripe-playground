import { Hono } from "hono";
import Stripe from "stripe";
import {
  CreatePaymentIntentRequestSchema,
  type CreatePaymentIntentResponse,
  type GetOrderResponse,
  OrderStatusSchema,
  RefundOrderRequestSchema,
  type RefundOrderResponse,
  RefundOrderResponseSchema,
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

  // DB-authoritative order status, fed by webhook transitions. The success
  // page polls this after redirect instead of trusting `redirect_status`.
  app.get("/order/:orderId", (c) => {
    const orderId = c.req.param("orderId");
    const row = deps.db.getOrder(orderId);
    if (!row) {
      return c.json({ ok: false, error: { type: "not_found" } }, 404);
    }
    const status = OrderStatusSchema.safeParse(row.status);
    if (!status.success) {
      // Row has a status the shared schema doesn't know about — treat as a
      // server-side invariant violation so we notice instead of returning
      // stale/unknown state to the UI.
      return c.json(
        {
          ok: false,
          error: { type: "unknown_status", value: row.status },
        },
        500,
      );
    }
    const res: GetOrderResponse = {
      orderId: row.order_id,
      paymentIntentId: row.payment_intent_id,
      amount: row.amount,
      currency: row.currency,
      status: status.data,
      updatedAt: row.updated_at,
    };
    return c.json(res);
  });

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

  // Full refund only (prototype scope). Client: POST { orderId }.
  // Flow: gate on DB order.status == "succeeded" -> stripe.refunds.create
  // with an orderId-derived idempotency key -> respond with the refund
  // shape. DB transition to "refunded" happens via the `charge.refunded`
  // webhook (wired in Stage 3), NOT here — that preserves webhook-
  // authoritative state machine invariants.
  app.post("/refund", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = RefundOrderRequestSchema.safeParse(body);
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
    const { orderId } = parsed.data;

    const order = deps.db.getOrder(orderId);
    if (!order) {
      return c.json({ ok: false, error: { type: "not_found" } }, 404);
    }
    // Only succeeded orders are refundable. `processing` means the charge
    // hasn't settled yet (Stripe's own refunds endpoint would 400); other
    // terminal states (failed/canceled) have nothing to refund; `refunded`
    // would double-refund if we didn't gate.
    if (order.status !== "succeeded") {
      return c.json(
        {
          ok: false,
          error: {
            type: "not_refundable",
            message: `order status must be "succeeded" to refund (current: ${order.status})`,
          },
        },
        409,
      );
    }

    // Pre-check for an existing refund on this PaymentIntent. This is
    // application-level idempotence independent of Stripe's 24h
    // idempotency-key cache — covers the stale-local-state path where the
    // initial `charge.refunded` webhook was missed, the order row stayed at
    // `succeeded`, the 24h window elapsed, and a retry would otherwise
    // create a duplicate refund. Stripe's API dedupes within 24h via our
    // Idempotency-Key; this dedupes beyond it.
    const existing = await deps.stripe.refunds.list({
      payment_intent: order.payment_intent_id,
      limit: 1,
    });
    const reused = existing.data[0];

    try {
      // Full-refund idempotency key. If this route ever grows partial
      // refunds, the key MUST include the amount or a client-supplied
      // attempt id (`order:<uuid>:refund:<amount>` or `:<client-uuid>`) —
      // otherwise two $5 refunds on a $20 order collide and Stripe either
      // returns `idempotency_key_in_use` or re-returns the first refund
      // object, faking "success" for a refund that was never created.
      const refund =
        reused ??
        (await deps.stripe.refunds
          .create(
            {
              payment_intent: order.payment_intent_id,
              // `requested_by_customer` is the closest fit for a user-
              // initiated refund button; surfaces in the Stripe dashboard.
              reason: "requested_by_customer",
              metadata: { order_id: orderId },
            },
            { idempotencyKey: `order:${orderId}:refund` },
          )
          .catch(async (err) => {
            // Concurrent-double-submit race — in practice the button is
            // disabled-on-pending so this fires only via hand-crafted
            // curl requests or identical-orderId retries under the 24h
            // idempotency window. Re-read from refunds.list and return
            // the winning refund instead of the error.
            if (
              err instanceof Stripe.errors.StripeIdempotencyError ||
              (err instanceof Stripe.errors.StripeError &&
                err.code === "idempotency_key_in_use")
            ) {
              await new Promise((r) => setTimeout(r, 150));
              const reread = await deps.stripe.refunds.list({
                payment_intent: order.payment_intent_id,
                limit: 1,
              });
              if (reread.data[0]) return reread.data[0];
            }
            throw err;
          }));
      // Stripe SDK types Refund.status as `string | null`; docs promise one
      // of pending/requires_action/succeeded/failed/canceled. Validate via
      // the shared schema so the response contract is enforced at the
      // server boundary and any novel status value trips a 500 instead of
      // leaking to the client.
      const parsedRefund = RefundOrderResponseSchema.safeParse({
        refundId: refund.id,
        paymentIntentId: order.payment_intent_id,
        orderId,
        amount: refund.amount,
        currency: refund.currency,
        status: refund.status ?? "pending",
      } satisfies Record<keyof RefundOrderResponse, unknown>);
      if (!parsedRefund.success) {
        // The refund already exists at Stripe (we have refund.id) — this
        // log line is the reconciliation anchor. Webhook `charge.refunded`
        // will still fire and flip the order row; the 500 here signals that
        // the client display has drifted from ground truth.
        console.error(
          `[refund] unexpected stripe refund shape`,
          {
            refundId: refund.id,
            status: refund.status,
            issues: parsedRefund.error.issues,
          },
        );
        return c.json(
          {
            ok: false,
            error: {
              type: "refund_shape_unexpected",
              refundId: refund.id,
            },
          },
          500,
        );
      }
      return c.json(parsedRefund.data);
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

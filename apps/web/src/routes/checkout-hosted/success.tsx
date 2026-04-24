import { createFileRoute, useSearch } from "@tanstack/react-router";
import { z } from "zod";
import { TERMINAL_ORDER_STATUSES } from "@stripe-prototype/shared";
import { useOrderPoll } from "../../lib/useOrderPoll";

// Stripe hosted Checkout typically appends `session_id` / `payment_intent` on
// success_url. We only need `order_id` for the poll, but we accept the
// others and passthrough anything else for forward-compat.
const SearchSchema = z
  .object({
    order_id: z.string().optional(),
    session_id: z.string().optional(),
  })
  .passthrough();

export const Route = createFileRoute("/checkout-hosted/success")({
  component: HostedSuccessPage,
  validateSearch: SearchSchema,
});

function HostedSuccessPage() {
  const search = useSearch({ from: "/checkout-hosted/success" });
  const orderId = search.order_id;
  const { order, isLoading, error, isNonTerminal, timedOut } =
    useOrderPoll(orderId);

  return (
    <div>
      <h1>payment submitted (hosted Checkout)</h1>
      <p>
        Stripe-hosted Checkout returned here after a paid or still-processing
        session. Two webhooks converge on this order: the
        Checkout-specific <code>checkout.session.completed</code> and the
        universal <code>payment_intent.succeeded</code>. First-wins via the
        idempotency gate in <code>processed_events</code>.
      </p>
      <dl>
        <dt>order status (authoritative)</dt>
        <dd>
          {!orderId && <code>—</code>}
          {orderId && isLoading && <code>loading…</code>}
          {orderId && error && (
            <code style={{ color: "crimson" }}>
              {error instanceof Error ? error.message : String(error)}
            </code>
          )}
          {orderId && order === null && (
            <code>order not found (did the webhook land?)</code>
          )}
          {orderId && order && (
            <>
              <code>{order.status}</code>
              {isNonTerminal && !timedOut && (
                <span style={{ color: "#666", fontSize: 12 }}>
                  {" "}
                  polling…
                </span>
              )}
              {timedOut && (
                <div style={{ color: "crimson", fontSize: 12, marginTop: 4 }}>
                  webhook didn't land in 2 minutes — check the Stripe dashboard
                  or server log
                </div>
              )}
              {TERMINAL_ORDER_STATUSES.has(order.status) && (
                <div style={{ fontSize: 12, color: "#666", marginTop: 4 }}>
                  pi <code>{order.paymentIntentId}</code>
                </div>
              )}
            </>
          )}
        </dd>
      </dl>
    </div>
  );
}

import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { TERMINAL_ORDER_STATUSES } from "@stripe-prototype/shared";
import { getOrder } from "../../lib/api";

// Stripe appends its own redirect keys (payment_intent,
// payment_intent_client_secret, redirect_status); we also ride along
// `order_id` from confirmPayment's return_url to anchor the DB poll.
// Any future PM type may add more keys (setup_intent, source_redirect_slug),
// so passthrough keeps them instead of tripping validateSearch.
const SearchSchema = z
  .object({
    payment_intent: z.string().optional(),
    payment_intent_client_secret: z.string().optional(),
    redirect_status: z
      .enum(["succeeded", "processing", "requires_action", "failed"])
      .optional(),
    order_id: z.string().optional(),
  })
  .passthrough();

export const Route = createFileRoute("/checkout/success")({
  component: SuccessPage,
  validateSearch: SearchSchema,
});

function SuccessPage() {
  const search = useSearch({ from: "/checkout/success" });
  const orderId = search.order_id;

  // Poll the API until the order reaches a terminal status. The redirect
  // lands before Stripe fires the webhook in test mode ~80% of the time, so
  // the first fetch is usually still "processing". refetchInterval is a
  // function so react-query stops polling automatically on terminal state.
  const order = useQuery({
    queryKey: ["order", orderId],
    queryFn: () => {
      if (!orderId) throw new Error("missing order_id");
      return getOrder(orderId);
    },
    enabled: !!orderId,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 2000;
      return TERMINAL_ORDER_STATUSES.has(data.status) ? false : 2000;
    },
  });

  return (
    <div>
      <h1>payment submitted</h1>
      <p>
        Stripe returned here after confirmPayment. Ground truth is the{" "}
        <code>payment_intent.succeeded</code> webhook — this page polls the
        API for the DB-authoritative order status instead of trusting{" "}
        <code>redirect_status</code>.
      </p>
      <dl>
        <dt>payment_intent</dt>
        <dd>
          <code>{search.payment_intent ?? "—"}</code>
        </dd>
        <dt>redirect_status (advisory)</dt>
        <dd>
          <code>{search.redirect_status ?? "—"}</code>
        </dd>
        <dt>order status (authoritative, via webhook)</dt>
        <dd>
          {!orderId && <code>—</code>}
          {orderId && order.isLoading && <code>loading…</code>}
          {orderId && order.error && (
            <code style={{ color: "crimson" }}>
              {order.error instanceof Error
                ? order.error.message
                : String(order.error)}
            </code>
          )}
          {orderId && order.data === null && (
            <code>order not found (did the webhook land?)</code>
          )}
          {orderId && order.data && (
            <>
              <code>{order.data.status}</code>
              {!TERMINAL_ORDER_STATUSES.has(order.data.status) && (
                <span style={{ color: "#666", fontSize: 12 }}>
                  {" "}
                  polling…
                </span>
              )}
            </>
          )}
        </dd>
      </dl>
    </div>
  );
}

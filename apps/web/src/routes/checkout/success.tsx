import { useEffect, useState } from "react";
import { createFileRoute, useSearch } from "@tanstack/react-router";
import { z } from "zod";
import { TERMINAL_ORDER_STATUSES } from "@stripe-prototype/shared";
import { useOrderPoll } from "../../lib/useOrderPoll";
import { RefundPanel } from "../../components/RefundPanel";

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
  // refundKey bumps useOrderPoll's restartKey (fresh 2-min budget) after a
  // refund POST succeeds; sawRefunded tracks whether the succeeded→refunded
  // transition has been observed, so the hook's `awaitingTransition` flag
  // flips off once the webhook lands and the poll naturally stops.
  const [refundKey, setRefundKey] = useState(0);
  const [sawRefunded, setSawRefunded] = useState(false);
  const { order, isLoading, error, isNonTerminal, timedOut } = useOrderPoll(
    orderId,
    {
      restartKey: refundKey,
      awaitingTransition: refundKey > 0 && !sawRefunded,
    },
  );
  useEffect(() => {
    if (order?.status === "refunded") setSawRefunded(true);
  }, [order?.status]);

  return (
    <div>
      <h1>payment submitted (Elements)</h1>
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
      {orderId && order && order.status === "succeeded" && (
        <RefundPanel
          orderId={orderId}
          onRefundInitiated={() => setRefundKey((k) => k + 1)}
        />
      )}
    </div>
  );
}

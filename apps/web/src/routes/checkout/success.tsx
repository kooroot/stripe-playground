import { useMemo, useRef } from "react";
import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { TERMINAL_ORDER_STATUSES } from "@stripe-prototype/shared";
import { getOrder } from "../../lib/api";

// Stop polling after 2 minutes. If the webhook hasn't landed by then it's
// either stuck upstream (Stripe side) or our handler threw after the
// idempotency gate burned the event.id — in either case, further polling
// won't help; the user needs to check the dashboard or server log.
const MAX_POLL_MS = 120_000;
const POLL_INTERVAL_MS = 2000;

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
  // `useMemo` runs once per mount (orderId doesn't change after validateSearch
  // parses the URL), so startedAt anchors the elapsed-time measurement.
  const startedAt = useMemo(() => Date.now(), []);
  const timedOutRef = useRef(false);

  // Poll the API until the order reaches a terminal status OR we've spent
  // more than MAX_POLL_MS waiting. The redirect lands before Stripe fires
  // the webhook in test mode ~80% of the time, so the first fetch is
  // usually still "processing". refetchInterval is a function so react-query
  // stops polling automatically on terminal state; the elapsed-ms check
  // backstops the case where the webhook never lands.
  const order = useQuery({
    queryKey: ["order", orderId],
    queryFn: () => {
      if (!orderId) throw new Error("missing order_id");
      return getOrder(orderId);
    },
    enabled: !!orderId,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return POLL_INTERVAL_MS;
      if (TERMINAL_ORDER_STATUSES.has(data.status)) return false;
      if (Date.now() - startedAt >= MAX_POLL_MS) {
        timedOutRef.current = true;
        return false;
      }
      return POLL_INTERVAL_MS;
    },
  });
  const isNonTerminal =
    !!order.data && !TERMINAL_ORDER_STATUSES.has(order.data.status);
  const timedOut = timedOutRef.current && isNonTerminal;

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
            </>
          )}
        </dd>
      </dl>
    </div>
  );
}

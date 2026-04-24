import { createFileRoute, Link, useSearch } from "@tanstack/react-router";
import { z } from "zod";

const SearchSchema = z
  .object({ order_id: z.string().optional() })
  .passthrough();

export const Route = createFileRoute("/checkout-hosted/cancel")({
  component: HostedCancelPage,
  validateSearch: SearchSchema,
});

function HostedCancelPage() {
  const search = useSearch({ from: "/checkout-hosted/cancel" });
  return (
    <div>
      <h1>checkout cancelled</h1>
      <p>
        The Stripe-hosted session was cancelled before a payment was captured.
        The order row in our DB is still present but has no terminal status;
        after the session's 24h TTL, <code>checkout.session.expired</code>{" "}
        fires and the order flips to <code>canceled</code> (only if still at{" "}
        <code>requires_payment_method</code> — async-in-flight PIs keep their
        PI-driven status).
      </p>
      {search.order_id && (
        <p style={{ fontSize: 12, color: "#666" }}>
          orderId <code>{search.order_id}</code>
        </p>
      )}
      <p>
        <Link to="/checkout-hosted">Try hosted checkout again</Link> — a new
        orderId is generated per visit, so this doesn't reuse the previous
        session.
      </p>
    </div>
  );
}

import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return (
    <div>
      <h1>stripe-prototype</h1>
      <p>Stage 4 — two checkout surfaces, same order-state backbone.</p>
      <ul>
        <li>
          <Link to="/checkout">/checkout</Link> — Elements inline (Stage 2 +
          Stage 3 webhook-authoritative)
        </li>
        <li>
          <Link to="/checkout-hosted">/checkout-hosted</Link> — Stripe-hosted
          Checkout Session (Stage 4)
        </li>
      </ul>
      <p style={{ fontSize: 12, color: "#666" }}>
        Both flows create a row in <code>orders</code> keyed by a server-
        generated UUID, drive terminal status from webhooks, and surface the
        DB-authoritative status on the success page.
      </p>
    </div>
  );
}

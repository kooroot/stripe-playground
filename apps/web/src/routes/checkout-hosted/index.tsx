import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { createCheckoutSession } from "../../lib/api";

export const Route = createFileRoute("/checkout-hosted/")({
  component: HostedCheckoutPage,
});

function HostedCheckoutPage() {
  const orderId = useMemo(() => crypto.randomUUID(), []);
  const [amount, setAmount] = useState(1999);
  const [productName, setProductName] = useState("Stripe prototype demo item");

  // We deliberately DON'T use window.location.replace on redirect: the raw
  // assign keeps history so the user can back-button to try again, matching
  // the UX most production hosted-checkout pages show.
  const session = useMutation({
    mutationFn: () =>
      createCheckoutSession({ orderId, amount, currency: "usd", productName }),
    onSuccess(data) {
      window.location.href = data.url;
    },
  });

  return (
    <div style={{ maxWidth: 520 }}>
      <h1>hosted checkout (Stage 4)</h1>
      <p style={{ fontSize: 12, color: "#666" }}>
        orderId <code>{orderId}</code>
      </p>
      <p>
        Stripe-hosted Checkout Session. The form below creates the session on
        the server and redirects to <code>checkout.stripe.com</code>. After
        payment (or cancel), Stripe redirects back to this app's{" "}
        <code>/checkout-hosted/success</code> or <code>/cancel</code>. Ground
        truth remains the webhooks, same as the Elements flow.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          session.mutate();
        }}
        style={{ display: "grid", gap: 12 }}
      >
        <label>
          product name
          <input
            type="text"
            value={productName}
            onChange={(e) => setProductName(e.target.value)}
            style={{ display: "block", width: "100%" }}
          />
        </label>
        <label>
          amount (USD cents)
          <input
            type="number"
            min={50}
            value={amount}
            onChange={(e) => setAmount(Number(e.target.value))}
            style={{ display: "block", width: "100%" }}
          />
        </label>
        <button type="submit" disabled={session.isPending}>
          {session.isPending ? "creating session..." : "go to Stripe Checkout"}
        </button>
        {session.error && (
          <p style={{ color: "crimson" }}>
            {session.error instanceof Error
              ? session.error.message
              : String(session.error)}
          </p>
        )}
      </form>
    </div>
  );
}

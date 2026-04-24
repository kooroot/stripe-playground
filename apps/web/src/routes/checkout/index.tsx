import { useMemo, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import { stripePromise } from "../../lib/stripe";
import { createPaymentIntent } from "../../lib/api";

export const Route = createFileRoute("/checkout/")({ component: CheckoutPage });

function CheckoutPage() {
  const orderId = useMemo(() => crypto.randomUUID(), []);
  const [amount, setAmount] = useState(1999);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [reused, setReused] = useState(false);

  const intent = useMutation({
    mutationFn: () =>
      createPaymentIntent({ orderId, amount, currency: "usd" }),
    onSuccess(data) {
      setClientSecret(data.clientSecret);
      setReused(data.status === "reused");
    },
  });

  return (
    <div style={{ maxWidth: 520 }}>
      <h1>checkout</h1>
      <p style={{ fontSize: 12, color: "#666" }}>
        orderId <code>{orderId}</code>
      </p>

      {!clientSecret && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            intent.mutate();
          }}
          style={{ display: "grid", gap: 12 }}
        >
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
          <button type="submit" disabled={intent.isPending}>
            {intent.isPending ? "creating intent..." : "create PaymentIntent"}
          </button>
          {intent.error && (
            <p style={{ color: "crimson" }}>
              {intent.error instanceof Error
                ? intent.error.message
                : String(intent.error)}
            </p>
          )}
        </form>
      )}

      {clientSecret && (
        <>
          <p style={{ fontSize: 12, color: "#666" }}>
            status: {reused ? "reused intent" : "new intent"}
          </p>
          <Elements
            stripe={stripePromise}
            options={{ clientSecret, appearance: { theme: "stripe" } }}
          >
            <PaymentForm />
          </Elements>
        </>
      )}
    </div>
  );
}

function PaymentForm() {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Guard against double submit when StrictMode double-invokes handlers.
  const inflight = useRef(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements || inflight.current) return;
    inflight.current = true;
    setSubmitting(true);
    setErr(null);

    const { error } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: `${window.location.origin}/checkout/success`,
      },
    });

    if (error) {
      setErr(error.message ?? "payment failed");
      setSubmitting(false);
      inflight.current = false;
    }
    // On success Stripe redirects; no cleanup path here.
  }

  return (
    <form onSubmit={onSubmit} style={{ display: "grid", gap: 12 }}>
      <PaymentElement />
      <button type="submit" disabled={!stripe || submitting}>
        {submitting ? "confirming..." : "pay"}
      </button>
      {err && <p style={{ color: "crimson" }}>{err}</p>}
    </form>
  );
}


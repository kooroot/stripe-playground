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

type IntentView =
  | { phase: "idle" }
  | { phase: "new" | "reused"; clientSecret: string; paymentIntentId: string }
  | { phase: "processing"; paymentIntentId: string };

function CheckoutPage() {
  const orderId = useMemo(() => crypto.randomUUID(), []);
  const [amount, setAmount] = useState(1999);
  const [view, setView] = useState<IntentView>({ phase: "idle" });

  const intent = useMutation({
    mutationFn: () =>
      createPaymentIntent({ orderId, amount, currency: "usd" }),
    onSuccess(data) {
      if (data.status === "processing") {
        setView({ phase: "processing", paymentIntentId: data.paymentIntentId });
      } else {
        if (!data.clientSecret) return;
        setView({
          phase: data.status,
          clientSecret: data.clientSecret,
          paymentIntentId: data.paymentIntentId,
        });
      }
    },
  });

  return (
    <div style={{ maxWidth: 520 }}>
      <h1>checkout</h1>
      <p style={{ fontSize: 12, color: "#666" }}>
        orderId <code>{orderId}</code>
      </p>

      {view.phase === "idle" && (
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

      {(view.phase === "new" || view.phase === "reused") && (
        <>
          <p style={{ fontSize: 12, color: "#666" }}>
            status: {view.phase === "reused" ? "reused intent" : "new intent"}
            {"  "}
            <code>{view.paymentIntentId}</code>
          </p>
          <Elements
            stripe={stripePromise}
            options={{
              clientSecret: view.clientSecret,
              appearance: { theme: "stripe" },
            }}
          >
            <PaymentForm />
          </Elements>
        </>
      )}

      {view.phase === "processing" && (
        <div>
          <p>
            PaymentIntent <code>{view.paymentIntentId}</code> is still
            processing on Stripe's side. Wait for the
            <code> payment_intent.succeeded</code> webhook (Stage 3) before
            treating the order as paid.
          </p>
          <p style={{ fontSize: 12, color: "#666" }}>
            Re-confirming with the same clientSecret would error — Stripe
            doesn't accept a second confirm on a processing intent.
          </p>
        </div>
      )}
    </div>
  );
}

function PaymentForm() {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Guards against double submit when the user hits Enter twice before
  // React commits the `setSubmitting(true)` tick that disables the button.
  // (StrictMode doesn't double-invoke event handlers, so this isn't about
  // StrictMode — it's about real double-Enter races.)
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


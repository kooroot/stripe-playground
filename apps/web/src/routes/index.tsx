import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return (
    <div>
      <h1>stripe-prototype</h1>
      <p>Stage 2 — PaymentIntent + Elements. Go to <code>/checkout</code>.</p>
    </div>
  );
}

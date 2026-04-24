import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/checkout/")({ component: CheckoutStub });

function CheckoutStub() {
  return (
    <div>
      <h1>checkout</h1>
      <p>Phase 2.3 wires up PaymentIntent + Elements here.</p>
    </div>
  );
}

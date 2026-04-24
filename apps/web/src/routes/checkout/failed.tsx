import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/checkout/failed")({ component: FailedPage });

function FailedPage() {
  return (
    <div>
      <h1>payment failed</h1>
      <p>
        The intent either declined or was cancelled. A new orderId will create
        a fresh PaymentIntent — retrying the same orderId reuses the open
        intent if it's still in a reusable state.
      </p>
      <Link to="/checkout">back to checkout</Link>
    </div>
  );
}

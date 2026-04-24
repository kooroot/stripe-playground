import { createFileRoute, useSearch } from "@tanstack/react-router";
import { z } from "zod";

// Stripe appends these three keys to the redirect URL after confirmPayment.
// Any future PM type may add more — e.g. source_redirect_slug, setup_intent.
// Use passthrough so unknown keys are preserved, not stripped or rejected.
const SearchSchema = z
  .object({
    payment_intent: z.string().optional(),
    payment_intent_client_secret: z.string().optional(),
    redirect_status: z
      .enum(["succeeded", "processing", "requires_action", "failed"])
      .optional(),
  })
  .passthrough();

export const Route = createFileRoute("/checkout/success")({
  component: SuccessPage,
  validateSearch: SearchSchema,
});

function SuccessPage() {
  const search = useSearch({ from: "/checkout/success" });
  return (
    <div>
      <h1>payment submitted</h1>
      <p>
        Stripe returned here after confirmPayment. Ground truth is the
        <code> payment_intent.succeeded</code> webhook — Stage 3 wires that in.
        Never mark an order paid solely from this redirect.
      </p>
      <dl>
        <dt>payment_intent</dt>
        <dd><code>{search.payment_intent ?? "—"}</code></dd>
        <dt>redirect_status</dt>
        <dd><code>{search.redirect_status ?? "—"}</code></dd>
      </dl>
    </div>
  );
}

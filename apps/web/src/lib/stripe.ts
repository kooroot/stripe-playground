import { loadStripe, type Stripe } from "@stripe/stripe-js";

const pk = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY;
if (!pk) {
  throw new Error(
    "VITE_STRIPE_PUBLISHABLE_KEY missing. Copy .env.example to .env and fill it in.",
  );
}
if (!pk.startsWith("pk_test_")) {
  // Matches the server-side sk_test_ hard-gate — prototype is test-mode only.
  throw new Error("VITE_STRIPE_PUBLISHABLE_KEY must start with pk_test_");
}

// loadStripe returns a Promise; cache the singleton per docs' recommendation.
export const stripePromise: Promise<Stripe | null> = loadStripe(pk);

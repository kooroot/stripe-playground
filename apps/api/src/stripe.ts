import Stripe from "stripe";

// Pin the wire-level API version so `stripe` npm bumps or dashboard-default
// migrations don't silently change behavior in Stage 2+. Matches the default
// shipped with `stripe@22.1.0` at the time of pin (2026-04-24).
export const STRIPE_API_VERSION = "2026-04-22.dahlia" as const;

export function makeStripe(secretKey: string): Stripe {
  return new Stripe(secretKey, {
    apiVersion: STRIPE_API_VERSION,
    typescript: true,
  });
}

import Stripe from "stripe";

export function makeStripe(secretKey: string): Stripe {
  return new Stripe(secretKey, {
    typescript: true,
  });
}

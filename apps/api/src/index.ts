import Stripe from "stripe";
import { Hono } from "hono";
import { loadEnv } from "./env";
import { makeStripe, STRIPE_API_VERSION } from "./stripe";

const env = loadEnv();
const stripe = makeStripe(env.STRIPE_SECRET_KEY);

const app = new Hono();

app.get("/", (c) =>
  c.json({ ok: true, stage: 1, api_version: STRIPE_API_VERSION }),
);

app.get("/health", async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    // Balance.retrieve() is the lightest "is the key valid + account reachable" call.
    await stripe.balance.retrieve();
    return c.json({ ok: true, mode: "test", api_version: STRIPE_API_VERSION });
  } catch (err) {
    // Never surface err.message: Stripe errors can include the last 4 of the
    // key or a request URL. Shape the response to type/code/requestId only.
    if (err instanceof Stripe.errors.StripeError) {
      const status = err instanceof Stripe.errors.StripeConnectionError ? 503 : 500;
      return c.json(
        {
          ok: false,
          error: {
            type: err.type,
            code: err.code ?? null,
            requestId: err.requestId ?? null,
          },
        },
        status,
      );
    }
    return c.json({ ok: false, error: { type: "unknown" } }, 500);
  }
});

export default {
  port: env.API_PORT,
  fetch: app.fetch,
};

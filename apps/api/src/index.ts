import { Hono } from "hono";
import { loadEnv } from "./env";
import { makeStripe } from "./stripe";

const env = loadEnv();
const stripe = makeStripe(env.STRIPE_SECRET_KEY);

const app = new Hono();

app.get("/", (c) => c.json({ ok: true, stage: 1 }));

app.get("/health", async (c) => {
  try {
    // Balance.retrieve() is the lightest "is the key valid + account reachable" call.
    await stripe.balance.retrieve();
    return c.json({
      ok: true,
      mode: env.STRIPE_SECRET_KEY.startsWith("sk_test_") ? "test" : "live",
    });
  } catch (err) {
    return c.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

export default {
  port: env.API_PORT,
  fetch: app.fetch,
};

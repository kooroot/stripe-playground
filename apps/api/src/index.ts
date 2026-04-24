import Stripe from "stripe";
import { Hono } from "hono";
import { loadEnv } from "./env";
import { makeStripe, STRIPE_API_VERSION } from "./stripe";
import { openDb } from "./db";
import { paymentsRoutes } from "./routes/payments";

const env = loadEnv();
const stripe = makeStripe(env.STRIPE_SECRET_KEY);
const db = await openDb(env.DATABASE_URL);

// Sanitized startup config — never the secret itself. Closes stage-1/#9
// ("Log sanitized startup config + document env precedence").
console.log(
  `[api] stage=2 mode=test port=${env.API_PORT} db=${db.file} api_version=${STRIPE_API_VERSION}`,
);

const app = new Hono();

app.route("/api/payments", paymentsRoutes({ stripe, db }));

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

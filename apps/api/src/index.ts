import Stripe from "stripe";
import { Hono } from "hono";
import { relative } from "node:path";
import { loadEnv } from "./env";
import { makeStripe, STRIPE_API_VERSION } from "./stripe";
import { openDb } from "./db";
import { paymentsRoutes } from "./routes/payments";
import { webhookRoutes } from "./routes/webhooks";

const env = loadEnv();
const stripe = makeStripe(env.STRIPE_SECRET_KEY);
const db = await openDb(env.DATABASE_URL);

// Webhook routes mount only when the secret is configured. Typecheck and the
// basic server (health + /intent) work without it so dev can still iterate
// on non-webhook flows; attempting to POST /api/webhooks/stripe without the
// secret just 404s, which is what we want (no fake-accepted events).
const webhooksEnabled = !!env.STRIPE_WEBHOOK_SECRET;

// Sanitized startup config — never the secret itself. DB path is logged
// relative to CWD so we don't leak /Users/<name>/... into transcripts.
// Closes stage-1/#9 ("Log sanitized startup config + document env precedence").
console.log(
  `[api] stage=3 mode=test port=${env.API_PORT} db=${relative(process.cwd(), db.file)} api_version=${STRIPE_API_VERSION} webhooks=${webhooksEnabled ? "on" : "off"}`,
);

const app = new Hono();

app.route("/api/payments", paymentsRoutes({ stripe, db }));
if (env.STRIPE_WEBHOOK_SECRET) {
  app.route(
    "/api/webhooks",
    webhookRoutes({ stripe, db, webhookSecret: env.STRIPE_WEBHOOK_SECRET }),
  );
}

app.get("/", (c) =>
  c.json({ ok: true, stage: 3, api_version: STRIPE_API_VERSION }),
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

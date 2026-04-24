/**
 * Stage 1 seed: hands-on practice with Stripe's core objects.
 *
 * Creates one Customer, one Product, one one-time Price, and one recurring
 * Price (all tagged `metadata.seed_tag`). Lists them via Stripe Search (with
 * bounded retry for eventual-consistency). Optionally cleans them up.
 *
 * Usage (root scripts pass args through `bun run seed -- ...`):
 *   bun run seed                         # create + list
 *   bun run seed -- --cleanup            # create + list + archive/delete
 *   bun run seed -- --tag=seed-1700... --cleanup  # clean up a prior run only
 */
import {
  SeedOneTimePriceSchema,
  SeedProductSchema,
  SeedRecurringPriceSchema,
} from "@stripe-prototype/shared";
import { loadEnv } from "../apps/api/src/env";
import { makeStripe } from "../apps/api/src/stripe";

type Args = {
  cleanup: boolean;
  tag: string | null;
};

function parseArgs(argv: readonly string[]): Args {
  let cleanup = false;
  let tag: string | null = null;
  for (const a of argv) {
    if (a === "--cleanup") cleanup = true;
    else if (a.startsWith("--tag=")) tag = a.slice("--tag=".length);
  }
  return { cleanup, tag };
}

async function retry<T>(
  op: () => Promise<T>,
  predicate: (result: T) => boolean,
  opts: { attempts: number; baseMs: number; label: string },
): Promise<T> {
  let last!: T;
  for (let i = 0; i < opts.attempts; i++) {
    last = await op();
    if (predicate(last)) return last;
    if (i < opts.attempts - 1) {
      const waitMs = opts.baseMs * Math.pow(2, i);
      console.log(
        `  ... ${opts.label} not ready after attempt ${i + 1}, retrying in ${waitMs}ms`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  return last;
}

const env = loadEnv();
const stripe = makeStripe(env.STRIPE_SECRET_KEY);
const args = parseArgs(process.argv.slice(2));
const tag = args.tag ?? `seed-${Date.now()}`;

type Created = {
  customerId: string;
  productId: string;
  oneTimePriceId: string;
  recurringPriceId: string;
};

async function create(): Promise<Created> {
  const product = SeedProductSchema.parse({
    name: `Prototype Widget (${tag})`,
    description: "Stage 1 seed object — safe to delete.",
  });
  const oneTime = SeedOneTimePriceSchema.parse({
    unit_amount: 1999,
    currency: "usd",
  });
  const recurring = SeedRecurringPriceSchema.parse({
    unit_amount: 999,
    currency: "usd",
    interval: "month",
  });

  const customer = await stripe.customers.create({
    email: `${tag}@example.com`,
    name: `Seed Customer ${tag}`,
    metadata: { seed_tag: tag },
  });
  console.log(`✓ customer  ${customer.id} (${customer.email})`);

  const createdProduct = await stripe.products.create({
    name: product.name,
    ...(product.description !== undefined
      ? { description: product.description }
      : {}),
    metadata: { seed_tag: tag },
  });
  console.log(`✓ product   ${createdProduct.id} (${createdProduct.name})`);

  const oneTimePrice = await stripe.prices.create({
    product: createdProduct.id,
    unit_amount: oneTime.unit_amount,
    currency: oneTime.currency,
    metadata: { seed_tag: tag, kind: "one_time" },
  });
  console.log(
    `✓ price     ${oneTimePrice.id} (one-time, ${oneTime.unit_amount} ${oneTime.currency})`,
  );

  const recurringPrice = await stripe.prices.create({
    product: createdProduct.id,
    unit_amount: recurring.unit_amount,
    currency: recurring.currency,
    recurring: { interval: recurring.interval },
    metadata: { seed_tag: tag, kind: "recurring" },
  });
  console.log(
    `✓ price     ${recurringPrice.id} (recurring ${recurring.interval}, ${recurring.unit_amount} ${recurring.currency})`,
  );

  return {
    customerId: customer.id,
    productId: createdProduct.id,
    oneTimePriceId: oneTimePrice.id,
    recurringPriceId: recurringPrice.id,
  };
}

async function list(tag: string): Promise<Created | null> {
  console.log(`\n--- listing objects tagged ${tag} (via Search, best-effort) ---`);
  // Stripe's docs use double-quoted metadata query values; single quotes work
  // on some shards and fail on others. Official syntax is `metadata["key"]:"value"`.
  const query = `metadata["seed_tag"]:"${tag}"`;

  // Search is eventually consistent — "searchable in less than a minute" per SDK
  // notes. Retry with exponential backoff instead of a magic sleep.
  const customers = await retry(
    () => stripe.customers.search({ query }),
    (r) => r.data.length > 0,
    { attempts: 4, baseMs: 750, label: "customer search" },
  );
  const products = await retry(
    () => stripe.products.search({ query }),
    (r) => r.data.length > 0,
    { attempts: 4, baseMs: 750, label: "product search" },
  );
  const prices = await retry(
    () => stripe.prices.search({ query }),
    (r) => r.data.length >= 2,
    { attempts: 4, baseMs: 750, label: "price search" },
  );

  for (const c of customers.data) {
    console.log(`  customer ${c.id} ${c.email ?? ""}`);
  }
  for (const p of products.data) {
    console.log(`  product  ${p.id} ${p.name}`);
  }
  for (const p of prices.data) {
    console.log(
      `  price    ${p.id} ${p.recurring ? `recurring/${p.recurring.interval}` : "one-time"} ${p.unit_amount} ${p.currency}`,
    );
  }

  if (!customers.data[0] || !products.data[0] || prices.data.length === 0) {
    console.log(
      "  (search may still be indexing; cleanup below uses direct IDs, not search)",
    );
    return null;
  }
  return {
    customerId: customers.data[0].id,
    productId: products.data[0].id,
    oneTimePriceId:
      prices.data.find((p) => !p.recurring)?.id ?? prices.data[0]!.id,
    recurringPriceId:
      prices.data.find((p) => p.recurring)?.id ?? prices.data[0]!.id,
  };
}

async function destroy(created: Created): Promise<void> {
  console.log(`\n--- cleaning up ${tag} (best-effort) ---`);

  const tryStep = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      console.log(`  ✓ ${label}`);
    } catch (err) {
      console.log(
        `  ✗ ${label} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  // Prices cannot be hard-deleted, only deactivated.
  await tryStep(`deactivate price ${created.oneTimePriceId}`, () =>
    stripe.prices.update(created.oneTimePriceId, { active: false }),
  );
  await tryStep(`deactivate price ${created.recurringPriceId}`, () =>
    stripe.prices.update(created.recurringPriceId, { active: false }),
  );
  // Products with any attached Prices cannot be hard-deleted either — archive
  // them (active: false) instead. `products.del` would return a 400.
  await tryStep(`archive product ${created.productId}`, () =>
    stripe.products.update(created.productId, { active: false }),
  );
  await tryStep(`delete customer ${created.customerId}`, () =>
    stripe.customers.del(created.customerId),
  );
}

if (args.tag && !args.cleanup) {
  // --tag without --cleanup: just list what's under that tag.
  await list(args.tag);
} else if (args.tag && args.cleanup) {
  // --tag with --cleanup: discover by search, clean up. Handles prior runs.
  const discovered = await list(args.tag);
  if (discovered) {
    await destroy(discovered);
  } else {
    console.log("  nothing to clean up under that tag");
  }
} else {
  // No --tag: normal "create + list + optional cleanup" flow.
  const created = await create();
  await list(tag);
  if (args.cleanup) {
    await destroy(created);
  }
}

console.log("\nDone.");

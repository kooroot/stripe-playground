#!/usr/bin/env bun
/**
 * Stage 1 seed: hands-on practice with Stripe's core objects.
 * Creates one Customer, one Product, one one-time Price, one recurring Price,
 * lists them, and (if `--cleanup`) deletes the objects this run created.
 *
 * Usage:
 *   bun run seed                # create + list
 *   bun run seed -- --cleanup   # create + list + delete
 */
import Stripe from "stripe";
import {
  SeedOneTimePriceSchema,
  SeedProductSchema,
  SeedRecurringPriceSchema,
} from "@stripe-prototype/shared";

const secret = Bun.env.STRIPE_SECRET_KEY;
if (!secret || !secret.startsWith("sk_test_")) {
  console.error(
    "STRIPE_SECRET_KEY missing or not a test key (must start with sk_test_).",
  );
  process.exit(1);
}

const stripe = new Stripe(secret, { typescript: true });
const cleanup = process.argv.includes("--cleanup");
const tag = `seed-${Date.now()}`;

type Created = {
  customer: Stripe.Customer;
  product: Stripe.Product;
  oneTimePrice: Stripe.Price;
  recurringPrice: Stripe.Price;
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

  return { customer, product: createdProduct, oneTimePrice, recurringPrice };
}

async function list(tag: string): Promise<void> {
  console.log(`\n--- listing objects tagged ${tag} ---`);
  const customers = await stripe.customers.search({
    query: `metadata['seed_tag']:'${tag}'`,
  });
  for (const c of customers.data) {
    console.log(`  customer ${c.id} ${c.email ?? ""}`);
  }
  const products = await stripe.products.search({
    query: `metadata['seed_tag']:'${tag}'`,
  });
  for (const p of products.data) {
    console.log(`  product  ${p.id} ${p.name}`);
  }
  const prices = await stripe.prices.search({
    query: `metadata['seed_tag']:'${tag}'`,
  });
  for (const p of prices.data) {
    console.log(
      `  price    ${p.id} ${p.recurring ? `recurring/${p.recurring.interval}` : "one-time"} ${p.unit_amount} ${p.currency}`,
    );
  }
}

async function destroy(created: Created): Promise<void> {
  console.log(`\n--- cleaning up ${tag} ---`);
  // Prices cannot be deleted, only deactivated.
  await stripe.prices.update(created.oneTimePrice.id, { active: false });
  console.log(`✓ price      ${created.oneTimePrice.id} deactivated`);
  await stripe.prices.update(created.recurringPrice.id, { active: false });
  console.log(`✓ price      ${created.recurringPrice.id} deactivated`);
  await stripe.products.del(created.product.id);
  console.log(`✓ product    ${created.product.id} deleted`);
  await stripe.customers.del(created.customer.id);
  console.log(`✓ customer   ${created.customer.id} deleted`);
}

const created = await create();

// Stripe search is eventually consistent — wait before listing, or the newly
// created objects may not appear in results.
await new Promise((r) => setTimeout(r, 2000));
await list(tag);

if (cleanup) {
  await destroy(created);
}

console.log("\nDone.");

import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { OrderStatus } from "@stripe-prototype/shared";

// Resolve relative DATABASE_URL from the apps/api package root, not the
// caller's CWD. One-place fix for stage-0/#6 and stage-1/#10 — running
// `bun --filter api dev` from repo root, `bun run dev` from `apps/api`, or
// `bun run seed` from root all land at the same DB file.
const API_ROOT = join(import.meta.dir, "..");

async function resolveDatabasePath(envPath: string): Promise<string> {
  const full = isAbsolute(envPath)
    ? envPath
    : join(API_ROOT, "..", "..", envPath);
  await mkdir(dirname(full), { recursive: true });
  return full;
}

export type OrderRow = {
  order_id: string;
  payment_intent_id: string;
  amount: number;
  currency: string;
  status: string;
  created_at: number;
  updated_at: number;
};

export type Db = {
  file: string;
  getOrder(orderId: string): OrderRow | null;
  getOrderByIntent(paymentIntentId: string): OrderRow | null;
  insertOrder(
    row: Omit<OrderRow, "created_at" | "updated_at" | "status"> & {
      status: OrderStatus;
    },
  ): void;
  // OrderStatus-typed so callers can't smuggle in an unknown string; the
  // shared enum is the canonical contract and the GET /order route will
  // 500 on anything outside it.
  updateOrderStatus(orderId: string, status: OrderStatus): void;
  // Webhook idempotency: returns true iff this event.id was newly recorded.
  // A false return means Stripe is re-delivering — skip the handler body.
  markEventProcessed(eventId: string, eventType: string): boolean;
  close(): void;
};

export async function openDb(envPath: string): Promise<Db> {
  const file = await resolveDatabasePath(envPath);
  const conn = new Database(file, { create: true, strict: true });

  conn.prepare("PRAGMA journal_mode = WAL").run();
  conn
    .prepare(
      `CREATE TABLE IF NOT EXISTS orders (
        order_id TEXT PRIMARY KEY,
        payment_intent_id TEXT NOT NULL,
        amount INTEGER NOT NULL,
        currency TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    )
    .run();
  // payment_intent_id lookup used by webhook handlers (charge.refunded carries
  // the intent id, not the order id). UNIQUE is correct because each order
  // has exactly one PaymentIntent by design (orderId-keyed create-or-reuse).
  conn
    .prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS orders_payment_intent_id_idx
         ON orders(payment_intent_id)`,
    )
    .run();
  // Webhook idempotency table. Stripe guarantees at-least-once delivery, so
  // the same event.id can arrive multiple times (network retries, CLI replay,
  // manual `stripe events resend`). Primary key on id gives us a single
  // atomic check: INSERT OR IGNORE + .changes tells us "first time?".
  conn
    .prepare(
      `CREATE TABLE IF NOT EXISTS processed_events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        received_at INTEGER NOT NULL
      )`,
    )
    .run();

  const getStmt = conn.query<OrderRow, { order_id: string }>(
    "SELECT * FROM orders WHERE order_id = $order_id",
  );
  const getByIntentStmt = conn.query<OrderRow, { payment_intent_id: string }>(
    "SELECT * FROM orders WHERE payment_intent_id = $payment_intent_id",
  );
  // INSERT OR IGNORE: on concurrent inserts for the same order_id, the
  // losing caller's row is silently dropped. They must re-read the DB to
  // get the winning row. The route layer handles that after catching
  // Stripe's `idempotency_key_in_use` error.
  const insertStmt = conn.query<
    unknown,
    {
      order_id: string;
      payment_intent_id: string;
      amount: number;
      currency: string;
      status: string;
      ts: number;
    }
  >(
    `INSERT OR IGNORE INTO orders
       (order_id, payment_intent_id, amount, currency, status, created_at, updated_at)
     VALUES
       ($order_id, $payment_intent_id, $amount, $currency, $status, $ts, $ts)`,
  );
  // status is the only mutable column after insert. amount, currency, and
  // payment_intent_id are immutable per orderId by design — letting them
  // drift would hide order_mismatch bugs and break idempotency-key semantics.
  const updateStatusStmt = conn.query<
    unknown,
    { order_id: string; status: string; ts: number }
  >(
    `UPDATE orders
       SET status = $status, updated_at = $ts
     WHERE order_id = $order_id`,
  );
  // INSERT OR IGNORE: duplicate event.id yields 0 row changes, which is the
  // signal for "Stripe re-delivered, skip". Wrapped in a dedicated method so
  // route code never sees the raw .changes count.
  const insertEventStmt = conn.prepare<
    unknown,
    [{ id: string; type: string; ts: number }]
  >(
    `INSERT OR IGNORE INTO processed_events (id, type, received_at)
     VALUES ($id, $type, $ts)`,
  );

  return {
    file,
    getOrder(orderId: string) {
      return getStmt.get({ order_id: orderId }) ?? null;
    },
    getOrderByIntent(paymentIntentId: string) {
      return (
        getByIntentStmt.get({ payment_intent_id: paymentIntentId }) ?? null
      );
    },
    insertOrder(row) {
      insertStmt.run({ ...row, ts: Date.now() });
    },
    updateOrderStatus(orderId: string, status: string) {
      updateStatusStmt.run({ order_id: orderId, status, ts: Date.now() });
    },
    markEventProcessed(eventId: string, eventType: string) {
      const result = insertEventStmt.run({
        id: eventId,
        type: eventType,
        ts: Date.now(),
      });
      return result.changes > 0;
    },
    close() {
      conn.close();
    },
  };
}

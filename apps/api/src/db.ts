import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

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
  insertOrder(
    row: Omit<OrderRow, "created_at" | "updated_at">,
  ): void;
  updateOrderStatus(orderId: string, status: string): void;
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

  const getStmt = conn.query<OrderRow, { order_id: string }>(
    "SELECT * FROM orders WHERE order_id = $order_id",
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

  return {
    file,
    getOrder(orderId: string) {
      return getStmt.get({ order_id: orderId }) ?? null;
    },
    insertOrder(row) {
      insertStmt.run({ ...row, ts: Date.now() });
    },
    updateOrderStatus(orderId: string, status: string) {
      updateStatusStmt.run({ order_id: orderId, status, ts: Date.now() });
    },
    close() {
      conn.close();
    },
  };
}

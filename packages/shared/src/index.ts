import { z } from "zod";

export const IsoCurrencySchema = z
  .string()
  .regex(/^[A-Za-z]{3}$/, {
    message: "currency must be a 3-letter ISO code (e.g. usd, eur)",
  })
  .transform((s) => s.toLowerCase());

export const SeedProductSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

export type SeedProduct = z.infer<typeof SeedProductSchema>;

export const SeedOneTimePriceSchema = z.object({
  unit_amount: z.number().int().positive(),
  currency: IsoCurrencySchema,
});

export const SeedRecurringPriceSchema = SeedOneTimePriceSchema.extend({
  interval: z.enum(["day", "week", "month", "year"]),
});

export type SeedOneTimePrice = z.infer<typeof SeedOneTimePriceSchema>;
export type SeedRecurringPrice = z.infer<typeof SeedRecurringPriceSchema>;

// ---------- Stage 2: PaymentIntent create-or-reuse contract ----------

// UUIDv4 or close variants — we don't care about version bits, we care about
// "not user-chosen" so collisions don't map two carts to one intent.
const OrderIdSchema = z
  .string()
  .regex(
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
    { message: "orderId must be a UUID" },
  );

// amount is always expressed in the smallest unit of `currency` (cents for USD,
// satang for THB, whole yen for JPY — zero-decimal — etc.). 50 is Stripe's
// minimum charge for USD; other currencies have their own floors but 50 is a
// safe conservative API-side guard above the zero/$0.01 case.
export const CreatePaymentIntentRequestSchema = z.object({
  orderId: OrderIdSchema,
  amount: z.number().int().min(50),
  currency: IsoCurrencySchema,
});
export type CreatePaymentIntentRequest = z.infer<
  typeof CreatePaymentIntentRequestSchema
>;

// Response shape is a discriminated union on `status`:
// - "new" | "reused" — a usable clientSecret is returned for PaymentElement
// - "processing" — no clientSecret (the prior intent is mid-settlement, the
//   client should render a "still processing" page instead of PaymentElement)
export const CreatePaymentIntentResponseSchema = z.object({
  clientSecret: z.string().nullable(),
  paymentIntentId: z.string(),
  orderId: z.string(),
  status: z.enum(["new", "reused", "processing"]),
});
export type CreatePaymentIntentResponse = z.infer<
  typeof CreatePaymentIntentResponseSchema
>;

// ---------- Stage 3: webhook-authoritative order status ----------

// Authoritative per-order state. `succeeded|failed|refunded|canceled` are
// TERMINAL. `succeeded|failed|refunded` are only set by webhook handlers;
// everything else mirrors the PaymentIntent status the create-or-reuse route
// wrote. The redirect_status query param on /checkout/success is advisory —
// source of truth is this enum, pulled via GET /api/payments/order/:orderId
// after the webhook lands.
//
// `requires_capture` is included for type-system closure: Stripe's
// PaymentIntent.Status union includes it, and while today's create path uses
// automatic capture (so the status is unreachable), the `insertOrder` path
// would otherwise silently fail-cast on any future intent created with
// capture_method: "manual". Keeps GET /order/:orderId from 500-ing in that
// case.
export const OrderStatusSchema = z.enum([
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
  "requires_capture",
  "processing",
  "succeeded",
  "failed",
  "refunded",
  "canceled",
]);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

export const TERMINAL_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set([
  "succeeded",
  "failed",
  "refunded",
  "canceled",
]);

export const GetOrderResponseSchema = z.object({
  orderId: z.string(),
  paymentIntentId: z.string(),
  amount: z.number().int(),
  currency: z.string(),
  status: OrderStatusSchema,
  updatedAt: z.number().int(),
});
export type GetOrderResponse = z.infer<typeof GetOrderResponseSchema>;

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

// ---------- Stage 4: hosted Checkout Session contract ----------

// Ad-hoc line_items via price_data: the hosted flow doesn't need a pre-seeded
// Price object to be usable, which keeps the prototype self-contained (Stage 1
// seed optional). Product display name + amount are passed per request.
export const CreateCheckoutSessionRequestSchema = z.object({
  orderId: OrderIdSchema,
  amount: z.number().int().min(50),
  currency: IsoCurrencySchema,
  productName: z.string().min(1).max(250),
});
export type CreateCheckoutSessionRequest = z.infer<
  typeof CreateCheckoutSessionRequestSchema
>;

// `url` is Stripe's hosted checkout URL (checkout.stripe.com/...). The web
// app redirects via `window.location.href = url`. `sessionId` is surfaced
// for observability; the route also persists the order pre-redirect so the
// success page poll picks it up the same way the Elements flow does.
export const CreateCheckoutSessionResponseSchema = z.object({
  url: z.string(),
  sessionId: z.string(),
  paymentIntentId: z.string().nullable(),
  orderId: z.string(),
  status: z.enum(["new", "reused"]),
});
export type CreateCheckoutSessionResponse = z.infer<
  typeof CreateCheckoutSessionResponseSchema
>;

// ---------- Stage 5: refund contract ----------

// Prototype-scoped refund: full-amount only, no partial refund UI. The server
// uses `stripe.refunds.create({payment_intent})` with an idempotency key
// keyed on orderId so a double-click produces one refund. Terminal order
// transition (succeeded → refunded) is wired via the `charge.refunded`
// webhook handler — this request only initiates the refund; the UI polls
// GET /api/payments/order/:orderId to observe the transition.
export const RefundOrderRequestSchema = z.object({
  orderId: OrderIdSchema,
});
export type RefundOrderRequest = z.infer<typeof RefundOrderRequestSchema>;

// `status` mirrors Stripe's Refund.status at create-time. For card refunds in
// test mode this is usually `succeeded` synchronously; for async PMs it can
// be `pending` (stablecoin/SEPA can take hours to days). Either way the
// order row flips to `refunded` only once `charge.refunded` fires.
export const RefundOrderResponseSchema = z.object({
  refundId: z.string(),
  paymentIntentId: z.string(),
  orderId: z.string(),
  amount: z.number().int(),
  currency: z.string(),
  status: z.enum(["pending", "requires_action", "succeeded", "failed", "canceled"]),
});
export type RefundOrderResponse = z.infer<typeof RefundOrderResponseSchema>;

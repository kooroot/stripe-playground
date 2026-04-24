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

export const CreatePaymentIntentRequestSchema = z.object({
  orderId: OrderIdSchema,
  amount: z.number().int().positive(),
  currency: IsoCurrencySchema,
});
export type CreatePaymentIntentRequest = z.infer<
  typeof CreatePaymentIntentRequestSchema
>;

export const CreatePaymentIntentResponseSchema = z.object({
  clientSecret: z.string(),
  paymentIntentId: z.string(),
  orderId: z.string(),
  status: z.enum(["new", "reused"]),
});
export type CreatePaymentIntentResponse = z.infer<
  typeof CreatePaymentIntentResponseSchema
>;

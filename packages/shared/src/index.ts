import { z } from "zod";

export const IsoCurrencySchema = z
  .string()
  .length(3)
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

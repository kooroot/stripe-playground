import { z } from "zod";

const EnvSchema = z.object({
  STRIPE_SECRET_KEY: z.string().regex(/^sk_(test|live)_/, {
    message: "STRIPE_SECRET_KEY must start with sk_test_ or sk_live_",
  }),
  STRIPE_WEBHOOK_SECRET: z
    .string()
    .regex(/^whsec_/, { message: "STRIPE_WEBHOOK_SECRET must start with whsec_" })
    .optional(),
  API_PORT: z.coerce.number().int().positive().default(8787),
  DATABASE_URL: z.string().default("apps/api/.data/stripe-prototype.db"),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(Bun.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
}

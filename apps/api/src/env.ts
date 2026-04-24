import { z } from "zod";

// Stage 1/2 policy: test-mode only. Live keys are rejected at startup so an
// accidental `.env` swap can't ship test-shaped code against real customers.
// Bun reads .env in this precedence: .env < .env.{NODE_ENV} < .env.local, and
// both dotenv files lose to shell/CI-supplied environment variables.
const EnvSchema = z.object({
  STRIPE_SECRET_KEY: z.string().regex(/^sk_test_/, {
    message:
      "STRIPE_SECRET_KEY must start with sk_test_ (live keys are rejected in this prototype)",
  }),
  STRIPE_WEBHOOK_SECRET: z
    .string()
    .regex(/^whsec_/, {
      message: "STRIPE_WEBHOOK_SECRET must start with whsec_",
    })
    .optional(),
  API_PORT: z.coerce.number().int().positive().default(8787),
  DATABASE_URL: z.string().default("apps/api/.data/stripe-prototype.db"),
});

export type Env = z.infer<typeof EnvSchema>;

function formatIssue(i: z.core.$ZodIssue): string {
  // Never echo the offending input back — a bad SECRET_KEY would leak to stderr.
  return `  - ${i.path.join(".") || "(env)"}: ${i.message}`;
}

export function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(Bun.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(formatIssue).join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
}

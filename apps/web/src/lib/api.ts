import {
  type CreatePaymentIntentRequest,
  type CreatePaymentIntentResponse,
  CreatePaymentIntentResponseSchema,
} from "@stripe-prototype/shared";

const BASE = import.meta.env.VITE_API_BASE_URL ?? "";

export async function createPaymentIntent(
  body: CreatePaymentIntentRequest,
): Promise<CreatePaymentIntentResponse> {
  const res = await fetch(`${BASE}/api/payments/intent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as unknown;
  if (!res.ok) {
    throw new Error(
      `api ${res.status}: ${JSON.stringify((json as { error?: unknown }).error ?? json)}`,
    );
  }
  return CreatePaymentIntentResponseSchema.parse(json);
}

import {
  type CreatePaymentIntentRequest,
  type CreatePaymentIntentResponse,
  CreatePaymentIntentResponseSchema,
  type CreateCheckoutSessionRequest,
  type CreateCheckoutSessionResponse,
  CreateCheckoutSessionResponseSchema,
  type GetOrderResponse,
  GetOrderResponseSchema,
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

export async function createCheckoutSession(
  body: CreateCheckoutSessionRequest,
): Promise<CreateCheckoutSessionResponse> {
  const res = await fetch(`${BASE}/api/checkout/session`, {
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
  return CreateCheckoutSessionResponseSchema.parse(json);
}

// Returns null on 404 (order not found — can happen if the success page
// loads before the DB write commits, though in practice the create-intent
// response has already flushed). Throws for other errors.
export async function getOrder(
  orderId: string,
): Promise<GetOrderResponse | null> {
  const res = await fetch(`${BASE}/api/payments/order/${orderId}`);
  if (res.status === 404) return null;
  const json = (await res.json()) as unknown;
  if (!res.ok) {
    throw new Error(
      `api ${res.status}: ${JSON.stringify((json as { error?: unknown }).error ?? json)}`,
    );
  }
  return GetOrderResponseSchema.parse(json);
}

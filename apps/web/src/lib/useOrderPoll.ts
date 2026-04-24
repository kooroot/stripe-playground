import { useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  TERMINAL_ORDER_STATUSES,
  type GetOrderResponse,
} from "@stripe-prototype/shared";
import { getOrder } from "./api";

// Stop polling after 2 minutes. If the webhook hasn't landed by then it's
// either stuck upstream (Stripe side) or our handler threw after the
// idempotency gate burned the event.id — in either case, further polling
// won't help; the user needs to check the dashboard or server log.
export const MAX_POLL_MS = 120_000;
export const POLL_INTERVAL_MS = 2000;

export type OrderPollState = {
  order: GetOrderResponse | null | undefined;
  isLoading: boolean;
  error: Error | null;
  isNonTerminal: boolean;
  timedOut: boolean;
};

export function useOrderPoll(orderId: string | undefined): OrderPollState {
  const startedAt = useMemo(() => Date.now(), []);
  const timedOutRef = useRef(false);

  const query = useQuery({
    queryKey: ["order", orderId],
    queryFn: () => {
      if (!orderId) throw new Error("missing order_id");
      return getOrder(orderId);
    },
    enabled: !!orderId,
    refetchInterval: (q) => {
      const data = q.state.data;
      if (!data) return POLL_INTERVAL_MS;
      if (TERMINAL_ORDER_STATUSES.has(data.status)) return false;
      if (Date.now() - startedAt >= MAX_POLL_MS) {
        timedOutRef.current = true;
        return false;
      }
      return POLL_INTERVAL_MS;
    },
  });

  const isNonTerminal =
    !!query.data && !TERMINAL_ORDER_STATUSES.has(query.data.status);

  return {
    order: query.data,
    isLoading: query.isLoading,
    error: query.error,
    isNonTerminal,
    timedOut: timedOutRef.current && isNonTerminal,
  };
}

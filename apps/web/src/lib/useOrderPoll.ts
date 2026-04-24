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
//
// ASSUMPTIONS (document-then-fix):
//
// - SPA-only: `useMemo(() => Date.now(), [])` captures the user's browser
//   clock at mount. If this hook ever runs in an SSR/Next.js "use server"
//   context, the anchor would be server clock — wrong. Under TanStack
//   Router's SPA setup today that's fine; migrate to a client-only
//   lazy-init useState if SSR lands.
//
// - Component remount resets the 2-minute budget. A user who navigates away
//   and comes back triggers a fresh poll window. Consumers that need a
//   mid-lifetime reset (e.g. post-refund terminal→terminal transition) can
//   bump `opts.restartKey` to re-anchor startedAt and clear timedOutRef.
//
// - `timedOutRef` is a one-shot tripwire: once set to true, it stays true
//   until either the hook remounts or `opts.restartKey` changes.
//
// - `opts.awaitingTransition` bypasses the terminal-stop check so a consumer
//   that just initiated a terminal→terminal transition (succeeded→refunded)
//   can keep polling. The time budget still applies as a safety net.
export const MAX_POLL_MS = 120_000;
export const POLL_INTERVAL_MS = 2000;

export type OrderPollState = {
  order: GetOrderResponse | null | undefined;
  isLoading: boolean;
  error: Error | null;
  isNonTerminal: boolean;
  timedOut: boolean;
};

export type UseOrderPollOptions = {
  // Bump (monotonic counter) to re-anchor the 2-minute budget and clear
  // timedOutRef without unmounting the component. Used by the refund flow
  // after a successful POST so the wait for `charge.refunded` gets a fresh
  // window. Counter > Date.now() so the "no reset yet" sentinel is 0 and
  // the restart semantics match the prop name (a bump, not a timestamp).
  restartKey?: number;
  // Keep polling past a terminal status. Enable when a consumer has
  // initiated an action that will cause a terminal→terminal transition
  // (e.g. succeeded→refunded) and needs to observe the next terminal state.
  awaitingTransition?: boolean;
};

export function useOrderPoll(
  orderId: string | undefined,
  opts: UseOrderPollOptions = {},
): OrderPollState {
  const { restartKey = 0, awaitingTransition = false } = opts;

  // Synchronously reset both startedAt and timedOutRef on restartKey change.
  // Prior shape used a separate useEffect for the ref — which runs AFTER
  // render, leaving one render where startedAt is fresh but timedOutRef
  // still reads the stale `true`. That window flashed the "timed out"
  // banner if the user clicked refund right as the 2-min budget tripped.
  // Colocating the reset inside useMemo eliminates the window.
  const timedOutRef = useRef(false);
  const startedAt = useMemo(() => {
    timedOutRef.current = false;
    return Date.now();
  }, [restartKey]);

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
      if (TERMINAL_ORDER_STATUSES.has(data.status) && !awaitingTransition) {
        return false;
      }
      if (Date.now() - startedAt >= MAX_POLL_MS) {
        timedOutRef.current = true;
        return false;
      }
      return POLL_INTERVAL_MS;
    },
  });

  const isNonTerminal =
    !!query.data && !TERMINAL_ORDER_STATUSES.has(query.data.status);
  // When awaiting a transition (post-refund), the UI still cares about
  // "did we time out before the new terminal landed?" — so timedOut stays
  // true as long as the consumer is awaiting, even if current status reads
  // terminal (the pre-transition terminal).
  const timedOut =
    timedOutRef.current && (isNonTerminal || awaitingTransition);

  return {
    order: query.data,
    isLoading: query.isLoading,
    error: query.error,
    isNonTerminal,
    timedOut,
  };
}

import { useMutation } from "@tanstack/react-query";
import { refundOrder } from "../lib/api";

// Shown on the success pages only when the order has landed in `succeeded`.
// Clicking `refund` POSTs /api/payments/refund; the DB transition to
// `refunded` is driven by the `charge.refunded` webhook (Stage 3 wiring), so
// the caller is expected to keep polling afterward. `onRefundInitiated`
// fires after the POST resolves so the caller can bump useOrderPoll's
// `restartKey` (re-anchor the 2-min budget) and flip `awaitingTransition`
// until it observes `refunded`.
export function RefundPanel({
  orderId,
  onRefundInitiated,
}: {
  orderId: string;
  onRefundInitiated: () => void;
}) {
  const mutation = useMutation({
    mutationFn: () => refundOrder({ orderId }),
    onSuccess: () => onRefundInitiated(),
  });

  return (
    <div style={{ marginTop: 12 }}>
      <button
        type="button"
        onClick={() => mutation.mutate()}
        disabled={mutation.isPending || mutation.isSuccess}
        style={{ padding: "6px 12px" }}
      >
        {mutation.isPending
          ? "requesting refund…"
          : mutation.isSuccess
            ? "refund requested"
            : "refund"}
      </button>
      {mutation.isError && (
        <div style={{ color: "crimson", fontSize: 12, marginTop: 4 }}>
          {mutation.error instanceof Error
            ? mutation.error.message
            : String(mutation.error)}
        </div>
      )}
      {mutation.isSuccess && mutation.data && (
        <div style={{ fontSize: 12, color: "#666", marginTop: 4 }}>
          refund <code>{mutation.data.refundId}</code> — stripe status:{" "}
          <code>{mutation.data.status}</code> (order flips to{" "}
          <code>refunded</code> when <code>charge.refunded</code> webhook
          lands)
        </div>
      )}
    </div>
  );
}

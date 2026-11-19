// The demo customer's orders and the refund rule (Module 4). Amounts come from
// the catalog, so the Refund agent can never be talked into a different price.
// Whether a refund goes through on its own is decided here, in code: the model
// only asks.
import { formatUsd, getPlans, getProducts } from "@/lib/copper/catalog";

export const CUSTOMER = "Jordan Ellis";

/** Refunds at or under this go through on their own; larger ones wait for a person. */
export const DEFAULT_LIMIT_USD = 100;

export type Order = {
  id: string;
  item: string;
  amountUsd: number;
  date: string;
};

/** paid → refunded, or paid → pending → refunded / rejected. */
export type OrderStatus = "paid" | "pending" | "refunded" | "rejected";

/** What the browser tells the server about the console on every question. */
export type RefundState = {
  limitUsd: number;
  statuses: Record<string, OrderStatus>;
};

export function getOrders(): Order[] {
  const home = getProducts().find((p) => p.id === "copper-home")!;
  const notes = getProducts().find((p) => p.id === "copper-notes")!;
  const plus = getPlans().find((p) => p.id === "copper-plus")!;
  return [
    {
      id: "1001",
      item: `${plus.name}, monthly`,
      amountUsd: plus.monthlyUsd,
      date: "2026-11-02",
    },
    {
      id: "1002",
      item: `${plus.name}, annual`,
      amountUsd: plus.annualUsd,
      date: "2026-11-09",
    },
    {
      id: "1003",
      item: notes.name,
      amountUsd: notes.priceUsd,
      date: "2026-11-12",
    },
    {
      id: "1004",
      item: home.name,
      amountUsd: home.priceUsd,
      date: "2026-11-14",
    },
  ];
}

export function statusOf(state: RefundState, orderId: string): OrderStatus {
  return state.statuses[orderId] ?? "paid";
}

export type RefundResult =
  | {
      status: "refunded" | "pending_approval";
      orderId: string;
      item: string;
      amountUsd: number;
      limitUsd: number;
    }
  | {
      status: "already_refunded" | "awaiting_approval" | "was_rejected";
      orderId: string;
      item: string;
      amountUsd: number;
    }
  | { status: "not_found"; orderId: string };

/** "#1002", "order 1002" or "1002" → "1002". */
export function normalizeOrderId(orderId: string): string {
  return orderId.replace(/\D/g, "");
}

/**
 * request_refund's rule. An order that's already been handled says so; a new
 * one is refunded at once when it's at or under the limit, and waits for a
 * person in the Refund Console when it's over.
 */
export function decideRefund(
  rawOrderId: string,
  state: RefundState,
): RefundResult {
  const orderId = normalizeOrderId(rawOrderId);
  const order = getOrders().find((o) => o.id === orderId);
  if (!order) return { status: "not_found", orderId: rawOrderId };
  const { item, amountUsd } = order;
  const current = statusOf(state, orderId);
  if (current === "refunded")
    return { status: "already_refunded", orderId, item, amountUsd };
  if (current === "pending")
    return { status: "awaiting_approval", orderId, item, amountUsd };
  if (current === "rejected")
    return { status: "was_rejected", orderId, item, amountUsd };
  const limitUsd = Math.max(0, state.limitUsd);
  return {
    status: amountUsd <= limitUsd ? "refunded" : "pending_approval",
    orderId,
    item,
    amountUsd,
    limitUsd,
  };
}

/** What the Refund agent tells the customer once a person decides. */
export function decisionMessage(order: Order, approved: boolean): string {
  const amount = formatUsd(order.amountUsd);
  return approved
    ? `Good news: your refund of ${amount} for order #${order.id} (${order.item}) was approved. The money is on its way back to your original payment method.`
    : `Sorry, your refund of ${amount} for order #${order.id} (${order.item}) was not approved, so no money was refunded. If you think that's a mistake, you can reach the Copper Crew in the Copper app (Settings > Help).`;
}

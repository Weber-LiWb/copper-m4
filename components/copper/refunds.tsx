"use client";

// The Refund Console (Module 4): the auto-refund limit, the refunds waiting
// for a person, and the customer's orders. The state lives in the browser and
// is shared with Ask Copper through RefundsProvider, so the chat can send it
// with each question and the console can post decisions back into the chat.
import { CheckIcon, RotateCcwIcon, XIcon } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatUsd } from "@/lib/copper/catalog";
import {
  CUSTOMER,
  DEFAULT_LIMIT_USD,
  decisionMessage,
  getOrders,
  type OrderStatus,
  type RefundResult,
  type RefundState,
} from "@/lib/copper/orders";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "copper-refunds";

/** A message from the Refund agent after a person approves or rejects. */
export type Decision = { id: number; text: string };

type Refunds = RefundState & {
  setLimitUsd: (limitUsd: number) => void;
  /** Updates an order from what request_refund returned. */
  applyResult: (result: RefundResult) => void;
  decide: (orderId: string, approved: boolean) => void;
  reset: () => void;
  decisions: Decision[];
};

const RefundsContext = createContext<Refunds | null>(null);

/** The console's state, or null on pages without a Refund Console. */
export function useRefunds() {
  return useContext(RefundsContext);
}

export function RefundsProvider({ children }: { children: ReactNode }) {
  const [limitUsd, setLimitUsd] = useState(DEFAULT_LIMIT_USD);
  const [statuses, setStatuses] = useState<Record<string, OrderStatus>>({});
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Remember the limit and order statuses across reloads in this browser. The
  // page is prerendered without them, so they're read once after it loads.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- loading saved state from localStorage once, after hydration */
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
      if (saved && typeof saved.limitUsd === "number") {
        setLimitUsd(saved.limitUsd);
        setStatuses(saved.statuses ?? {});
      }
    } catch {}
    setLoaded(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ limitUsd, statuses }));
    } catch {}
  }, [loaded, limitUsd, statuses]);

  const applyResult = useCallback((result: RefundResult) => {
    const next: OrderStatus | null =
      result.status === "refunded"
        ? "refunded"
        : result.status === "pending_approval"
          ? "pending"
          : null;
    if (next) setStatuses((all) => ({ ...all, [result.orderId]: next }));
  }, []);

  const decide = useCallback((orderId: string, approved: boolean) => {
    const order = getOrders().find((o) => o.id === orderId);
    if (!order) return;
    setStatuses((all) => ({
      ...all,
      [orderId]: approved ? "refunded" : "rejected",
    }));
    setDecisions((all) => [
      ...all,
      { id: all.length + 1, text: decisionMessage(order, approved) },
    ]);
  }, []);

  const reset = useCallback(() => {
    setStatuses({});
    setLimitUsd(DEFAULT_LIMIT_USD);
  }, []);

  const value = useMemo(
    () => ({
      limitUsd,
      statuses,
      setLimitUsd,
      applyResult,
      decide,
      reset,
      decisions,
    }),
    [limitUsd, statuses, applyResult, decide, reset, decisions],
  );
  return (
    <RefundsContext.Provider value={value}>{children}</RefundsContext.Provider>
  );
}

const STATUS_LABELS: Record<OrderStatus, string> = {
  paid: "Paid",
  pending: "Waiting for approval",
  refunded: "Refunded",
  rejected: "Refund rejected",
};

function StatusBadge({ status }: { status: OrderStatus }) {
  return (
    <Badge
      variant={status === "paid" ? "outline" : "default"}
      className={cn(
        status === "pending" && "bg-chart-4 text-chart-5",
        status === "refunded" && "bg-accent text-white",
        status === "rejected" && "bg-chart-3 text-white",
      )}
    >
      {STATUS_LABELS[status]}
    </Badge>
  );
}

export function RefundConsole() {
  const refunds = useRefunds();
  const [draft, setDraft] = useState<string | null>(null);
  if (!refunds) return null;
  const { limitUsd, statuses, setLimitUsd, decide, reset } = refunds;
  const orders = getOrders();
  const waiting = orders.filter((o) => statuses[o.id] === "pending");

  return (
    <div className="mt-6 space-y-8">
      <p className="text-muted-foreground">
        Ask for a refund in the chat as the customer. Copper hands the request
        to the Refund agent, which asks the app for the refund. The app checks
        the amount against your limit: at or under it, the refund goes through
        on its own; over it, it waits here for you to approve or reject.
      </p>

      <section className="bg-card space-y-2 rounded-xl border p-4">
        <Label htmlFor="limit" className="text-base font-semibold">
          Auto-refund limit
        </Label>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-lg">$</span>
          <Input
            id="limit"
            type="number"
            min={0}
            step={1}
            value={draft ?? String(limitUsd)}
            onChange={(event) => {
              setDraft(event.target.value);
              const value = Number(event.target.value);
              if (event.target.value !== "" && value >= 0) setLimitUsd(value);
            }}
            onBlur={() => setDraft(null)}
            className="w-32 text-lg font-semibold"
          />
        </div>
        <p className="text-muted-foreground text-sm">
          Refunds up to {formatUsd(limitUsd)} go through on their own. Anything
          larger needs your approval.
        </p>
      </section>

      <section data-testid="approval-queue" className="space-y-3">
        <h2 className="font-display text-xl font-bold">
          Waiting for your approval
        </h2>
        {waiting.length === 0 ? (
          <p className="text-muted-foreground rounded-xl border border-dashed p-4 text-sm">
            Nothing is waiting. Refunds over the limit will stop here.
          </p>
        ) : (
          waiting.map((order) => (
            <div
              key={order.id}
              data-testid="pending-refund"
              className="border-chart-4 bg-chart-4/10 flex flex-wrap items-center gap-3 rounded-xl border p-4"
            >
              <div className="min-w-0 flex-1">
                <p className="font-semibold">
                  #{order.id} · {order.item}
                </p>
                <p className="text-muted-foreground text-sm">
                  {CUSTOMER} asked for {formatUsd(order.amountUsd)}, over your{" "}
                  {formatUsd(limitUsd)} limit.
                </p>
              </div>
              <Button onClick={() => decide(order.id, true)}>
                <CheckIcon /> Approve
              </Button>
              <Button variant="outline" onClick={() => decide(order.id, false)}>
                <XIcon /> Reject
              </Button>
            </div>
          ))
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="font-display text-xl font-bold">
            {CUSTOMER}&apos;s orders
          </h2>
          <Button variant="ghost" size="sm" onClick={reset}>
            <RotateCcwIcon /> Reset demo
          </Button>
        </div>
        <div className="bg-card rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead>Item</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((order) => (
                <TableRow key={order.id} data-testid={`order-${order.id}`}>
                  <TableCell className="font-mono">#{order.id}</TableCell>
                  <TableCell>{order.item}</TableCell>
                  <TableCell className="text-right font-mono">
                    {formatUsd(order.amountUsd)}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={statuses[order.id] ?? "paid"} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  );
}

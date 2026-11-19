// Module 4: refunds. Copper hands refund requests to the Refund agent; code
// refunds anything at or under the limit and queues the rest for a person in
// the Refund Console, whose Approve / Reject decision shows up in the chat.
// Mock models only, so these need no AI key.
import type { LanguageModelV4StreamPart as ModelStreamPart } from "@ai-sdk/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLive, finalValue } from "@/lib/ai/live";
import { type Progress, toolCallsOf } from "@/lib/copper/assistant/progress";
import {
  decideRefund,
  DEFAULT_LIMIT_USD,
  getOrders,
  type RefundState,
} from "@/lib/copper/orders";

let model: MockLanguageModelV4;
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => model,
}));

const usage = {
  inputTokens: {
    total: 100,
    noCache: 100,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};

type StreamPart = Parameters<
  typeof convertArrayToReadableStream<ModelStreamPart>
>[0][number];

const finish = (reason: "stop" | "tool-calls") => ({
  type: "finish" as const,
  finishReason: { unified: reason, raw: undefined },
  usage,
});

const says = (text: string): StreamPart[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  finish("stop"),
];

let callNumber = 0;
const calls = (toolName: string, input: unknown): StreamPart[] => {
  const id = `call-${++callNumber}`;
  return [
    { type: "tool-input-start", id, toolName },
    { type: "tool-input-end", id },
    {
      type: "tool-call",
      toolCallId: id,
      toolName,
      input: JSON.stringify(input),
    },
    finish("tool-calls"),
  ];
};

function modelStreaming(...steps: StreamPart[][]) {
  let step = 0;
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream(steps[step++] ?? says("")),
    }),
  });
}

const fresh = (limitUsd = DEFAULT_LIMIT_USD): RefundState => ({
  limitUsd,
  statuses: {},
});

let logged: Record<string, unknown>[] = [];

beforeEach(() => {
  callNumber = 0;
  logged = [];
  localStorage.clear();
  vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
    if (args[0] === "[ai_calls]") logged.push(JSON.parse(args[1] as string));
  });
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "test-key");
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.doUnmock("@/lib/copper/assistant/ask");
  vi.resetModules();
});

describe("the orders", () => {
  it("are priced from the catalog", () => {
    expect(getOrders().map((o) => [o.id, o.amountUsd])).toEqual([
      ["1001", 7.99],
      ["1002", 79],
      ["1003", 129],
      ["1004", 149],
    ]);
  });
});

describe("the refund rule (code, not the model)", () => {
  it("refunds at or under the limit and queues anything over it", () => {
    expect(decideRefund("1002", fresh(100)).status).toBe("refunded");
    expect(decideRefund("#1004", fresh(100)).status).toBe("pending_approval");
    expect(decideRefund("order 1003", fresh(100)).status).toBe(
      "pending_approval",
    );
    expect(decideRefund("1004", fresh(149)).status).toBe("refunded");
    expect(decideRefund("1001", fresh(0)).status).toBe("pending_approval");
  });

  it("doesn't refund an order twice or reopen a decision", () => {
    const state = (status: "refunded" | "pending" | "rejected") => ({
      limitUsd: 1000,
      statuses: { "1002": status },
    });
    expect(decideRefund("1002", state("refunded")).status).toBe(
      "already_refunded",
    );
    expect(decideRefund("1002", state("pending")).status).toBe(
      "awaiting_approval",
    );
    expect(decideRefund("1002", state("rejected")).status).toBe("was_rejected");
    expect(decideRefund("9999", fresh()).status).toBe("not_found");
  });
});

describe("Copper hands refunds to the Refund agent", () => {
  it("runs a second agent with the refund tools after the hand-off", async () => {
    model = modelStreaming(
      calls("transfer_to_refund_agent", {}),
      calls("request_refund", { orderId: "1004" }),
      says("Hi, I'm the Refund agent. It needs approval."),
    );
    const { askCopper } = await import("@/lib/copper/assistant/ask");
    const progress: Progress = await finalValue(
      (
        await askCopper({
          messages: [{ role: "user", content: "Refund order #1004" }],
          useTools: true,
          refunds: fresh(),
        })
      ).progress,
    );
    expect(progress.status).toBe("done");
    expect(progress.agent).toBe("refund");
    expect(progress.steps.some((s) => s.type === "handoff")).toBe(true);
    const [transfer, refund] = toolCallsOf(progress);
    expect(transfer.name).toBe("transfer_to_refund_agent");
    expect(refund.name).toBe("request_refund");
    expect(refund.output).toMatchObject({
      status: "pending_approval",
      orderId: "1004",
      amountUsd: 149,
    });
    expect(progress.reply).toBe("Hi, I'm the Refund agent. It needs approval.");

    // Copper offers the hand-off; the Refund agent has only its own tools.
    const toolsOf = (i: number) =>
      (model.doStreamCalls[i].tools ?? []).map((t) => t.name).sort();
    expect(toolsOf(0)).toContain("transfer_to_refund_agent");
    expect(toolsOf(0)).not.toContain("request_refund");
    expect(toolsOf(1)).toEqual(["get_orders", "request_refund"]);
    expect(logged.map((row) => row.feature)).toEqual([
      "ask-copper",
      "refund-agent",
    ]);
  });

  it("doesn't offer the hand-off where there is no Refund Console", async () => {
    model = modelStreaming(says("Hello!"));
    const { askCopper } = await import("@/lib/copper/assistant/ask");
    await finalValue(
      (
        await askCopper({
          messages: [{ role: "user", content: "Hi" }],
          useTools: true,
        })
      ).progress,
    );
    const names = (model.doStreamCalls[0].tools ?? []).map((t) => t.name);
    expect(names).not.toContain("transfer_to_refund_agent");
  });
});

/** A finished answer in which the Refund agent asked for a refund. */
function refundAnswer(output: unknown) {
  const { live, done } = createLive<Progress>();
  done({
    status: "done",
    agent: "refund",
    reply: "Hi, I'm the Refund agent.",
    steps: [
      {
        type: "tool",
        id: "c1",
        name: "transfer_to_refund_agent",
        state: "done",
        input: {},
        output: {},
      },
      { type: "handoff", to: "refund" },
      {
        type: "tool",
        id: "c2",
        name: "request_refund",
        state: "done",
        input: {},
        output,
      },
    ],
  });
  return { progress: live };
}

async function renderSupport(askCopper?: ReturnType<typeof vi.fn>) {
  vi.resetModules();
  if (askCopper) vi.doMock("@/lib/copper/assistant/ask", () => ({ askCopper }));
  const { default: Support } = await import("@/app/support/page");
  render(<Support />);
  return within(await screen.findByTestId("ask-copper"));
}

describe("the Refund Console", () => {
  it("shows the $100 limit, an empty queue and the orders", async () => {
    await renderSupport();
    expect(screen.getByLabelText("Auto-refund limit")).toHaveValue(100);
    expect(
      within(screen.getByTestId("approval-queue")).getByText(
        /Nothing is waiting/,
      ),
    ).toBeVisible();
    for (const id of ["1001", "1002", "1003", "1004"])
      expect(screen.getByTestId(`order-${id}`)).toHaveTextContent("Paid");
  });

  it("marks an order refunded when the app refunds it on its own", async () => {
    const askCopper = vi.fn().mockImplementation(async () =>
      refundAnswer({
        status: "refunded",
        orderId: "1002",
        item: "Copper Plus, annual",
        amountUsd: 79,
        limitUsd: 100,
      }),
    );
    const chat = await renderSupport(askCopper);
    fireEvent.click(chat.getByText("Please refund order #1002."));
    await waitFor(() =>
      expect(screen.getByTestId("order-1002")).toHaveTextContent("Refunded"),
    );
    expect(askCopper.mock.calls[0][0].refunds).toEqual({
      limitUsd: 100,
      statuses: {},
    });
    expect(chat.getByTestId("handoff")).toBeVisible();
    expect(chat.getAllByText("Refund agent").length).toBeGreaterThan(0);
  });

  it("queues a large refund; Approve refunds it and the chat says so", async () => {
    const askCopper = vi.fn().mockImplementation(async () =>
      refundAnswer({
        status: "pending_approval",
        orderId: "1004",
        item: "Copper Home",
        amountUsd: 149,
        limitUsd: 100,
      }),
    );
    const chat = await renderSupport(askCopper);
    fireEvent.click(chat.getByText(/refund for order #1004/));
    const pending = await screen.findByTestId("pending-refund");
    expect(pending).toHaveTextContent("#1004");
    expect(screen.getByTestId("order-1004")).toHaveTextContent(
      "Waiting for approval",
    );
    fireEvent.click(within(pending).getByRole("button", { name: /Approve/ }));
    expect(screen.getByTestId("order-1004")).toHaveTextContent("Refunded");
    expect(screen.queryByTestId("pending-refund")).toBeNull();
    expect(await chat.findByTestId("refund-decision")).toHaveTextContent(
      /\$149 for order #1004 .* was approved/,
    );
  });

  it("Reject keeps the money and the chat tells the customer", async () => {
    localStorage.setItem(
      "copper-refunds",
      JSON.stringify({ limitUsd: 100, statuses: { "1003": "pending" } }),
    );
    const chat = await renderSupport();
    const pending = await screen.findByTestId("pending-refund");
    fireEvent.click(within(pending).getByRole("button", { name: /Reject/ }));
    expect(screen.getByTestId("order-1003")).toHaveTextContent(
      "Refund rejected",
    );
    expect(await chat.findByTestId("refund-decision")).toHaveTextContent(
      /was not approved, so no money was refunded/,
    );
  });

  it("uses the limit you set", async () => {
    await renderSupport();
    fireEvent.change(screen.getByLabelText("Auto-refund limit"), {
      target: { value: "150" },
    });
    expect(screen.getByText(/Refunds up to \$150 go through/)).toBeVisible();
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem("copper-refunds")!).limitUsd).toBe(
        150,
      ),
    );
  });
});

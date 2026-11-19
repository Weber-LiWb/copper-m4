"use server";

// The server action the Ask Copper chat calls. It streams the conversation to
// the model through callStream (lib/ai/call.ts), with or without the tools,
// and sends back each step as it happens, so the panel can show Copper
// thinking and using its tools.
// On the Support page (Module 4) Copper can hand the conversation to a second
// agent, the Refund agent, which has its own instructions and tools.
import { hasToolCall, stepCountIs } from "ai";
import { callStream, THOUGHT_SUMMARIES } from "@/lib/ai/call";
import { createLive, type Live } from "@/lib/ai/live";
import {
  COPPER_INSTRUCTIONS,
  REFUND_INSTRUCTIONS,
} from "@/lib/copper/assistant/instructions";
import {
  type Progress,
  type ToolStep,
  TRANSFER_TOOL,
} from "@/lib/copper/assistant/progress";
import {
  copperTools,
  refundTools,
  transferTool,
} from "@/lib/copper/assistant/tools";
import type { RefundState } from "@/lib/copper/orders";

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type AskCopperRequest = {
  messages: ChatMessage[];
  useTools: boolean;
  /** The Refund Console's limit and order statuses, sent from the Support page. */
  refunds?: RefundState;
};

export type AskCopperResult = { progress: Live<Progress> };

/** At most this many model steps (tool calls plus the reply) per agent. */
const MAX_STEPS = 5;

const SORRY = "Sorry, something went wrong on my end. Please try again.";

export async function askCopper({
  messages,
  useTools,
  refunds,
}: AskCopperRequest): Promise<AskCopperResult> {
  const { live, update, done } = createLive<Progress>();
  const progress: Progress = {
    steps: [],
    reply: "",
    status: "working",
    agent: "copper",
  };
  // A fresh copy each time, so earlier updates never change underneath the
  // panel.
  const snapshot = (): Progress => ({
    ...progress,
    steps: progress.steps.map((step) => ({ ...step })),
  });
  const toolStep = (id: string) =>
    progress.steps.find(
      (step): step is ToolStep => step.type === "tool" && step.id === id,
    );

  /** Reads one agent's stream into `progress`. True if it handed off. */
  async function follow(result: ReturnType<typeof callStream>) {
    let handedOff = false;
    for await (const part of result.fullStream) {
      switch (part.type) {
        case "reasoning-delta": {
          const last = progress.steps.at(-1);
          if (last?.type === "thinking") last.text += part.text;
          else progress.steps.push({ type: "thinking", text: part.text });
          break;
        }
        case "tool-input-start":
          progress.steps.push({
            type: "tool",
            id: part.id,
            name: part.toolName,
            state: "calling",
          });
          break;
        case "tool-call": {
          if (part.toolName === TRANSFER_TOOL) handedOff = true;
          const step = toolStep(part.toolCallId);
          if (step) step.input = part.input;
          else
            progress.steps.push({
              type: "tool",
              id: part.toolCallId,
              name: part.toolName,
              state: "calling",
              input: part.input,
            });
          break;
        }
        case "tool-result": {
          const step = toolStep(part.toolCallId);
          if (step) Object.assign(step, { output: part.output, state: "done" });
          break;
        }
        case "tool-error": {
          const step = toolStep(part.toolCallId);
          const message =
            part.error instanceof Error
              ? part.error.message
              : String(part.error);
          if (step) Object.assign(step, { output: message, state: "error" });
          break;
        }
        case "text-delta":
          progress.reply += part.text;
          break;
        case "error":
          throw part.error;
        default:
          continue;
      }
      update(snapshot());
    }
    return handedOff;
  }

  // Without tools, send no instructions either: "always use your tools" with
  // no tools makes the model answer with nothing.
  const copper = callStream(
    { module: 2, feature: "ask-copper" },
    {
      messages,
      providerOptions: THOUGHT_SUMMARIES,
      ...(useTools && {
        instructions: COPPER_INSTRUCTIONS,
        tools: refunds ? { ...copperTools, ...transferTool } : copperTools,
        // Copper stops as soon as it hands off; the Refund agent replies.
        stopWhen: [stepCountIs(MAX_STEPS), hasToolCall(TRANSFER_TOOL)],
      }),
    },
  );

  // Read the stream in the background, so the panel gets the first update now.
  void (async () => {
    try {
      const handedOff = await follow(copper);
      if (handedOff && refunds) {
        progress.reply = "";
        progress.agent = "refund";
        progress.steps.push({ type: "handoff", to: "refund" });
        update(snapshot());
        await follow(
          callStream(
            { module: 4, feature: "refund-agent" },
            {
              messages,
              providerOptions: THOUGHT_SUMMARIES,
              instructions: REFUND_INSTRUCTIONS,
              tools: refundTools(refunds),
              stopWhen: stepCountIs(MAX_STEPS),
            },
          ),
        );
      }
      progress.status = "done";
      if (!progress.reply.trim()) progress.reply = SORRY;
    } catch {
      progress.status = "error";
      if (!progress.reply.trim()) progress.reply = SORRY;
    }
    done(snapshot());
  })();

  return { progress: live };
}

# Architecture

How the Copper State Labs app fits together. Each module adds a section at the
end (see [Adding a module](#adding-a-module)) when it changes how the app
works: new pages, tables or AI calls.

_Fictional — for educational use._

## The starter app (Module 0)

A Next.js app that builds, runs and deploys with **no environment variables**.
A Google AI Studio key is optional until a module needs one.

| Piece | Where | What it does |
|---|---|---|
| Pages | `app/` | `layout.tsx` sets the fonts and theme; `page.tsx` is the placeholder home page |
| Brand components | `components/copper/` | `Logo`, `SiteHeader`, `SiteFooter`, `ModeToggle` |
| UI kit | `components/ui/` (shadcn), `components/ai-elements/` (AI Elements) | The only UI libraries the app uses |
| Setup card | `components/setup-required.tsx` | `<SetupRequired service="ai" />`, shown instead of a page whose service isn't configured |
| Company catalog | `lib/copper/catalog.ts`, `lib/copper/data/catalog.json` | Product, plan and privacy facts from the Product Bible (Sections 3, 4, 8 and 10). Pages read prices and plan details from here instead of typing them (added in the Module 1 starter) |
| AI wrapper | `lib/ai/call.ts` | `callText` and `callObject`: every model call goes through these and is logged to the terminal |
| Models and prices | `lib/ai/models.ts`, `lib/ai/pricing.ts` | The approved Gemini models and their token prices |

## Data flow

1. A user opens a page in `app/`.
2. Server code checks what's configured (`isAiConfigured()`). If the key is
   missing, the page renders `<SetupRequired />` instead of crashing.
3. Data comes from files under `lib/copper/data/`.
4. AI requests go through `callText` / `callObject` in `lib/ai/call.ts`, which
   calls Google and then prints one `[ai_calls]` line: `module`, `feature`,
   `model`, tokens, `cost_usd`, `latency_ms`, `ok`.

```ts
const { text } = await callText(
  { module: 2, feature: "ask-copper" },
  { prompt },
);
```

## Two kinds of "AI tiers"

Don't mix these up:

- **Copper State Labs' product tiers** (On-device, Raw Ore, Refined, the
  Copper Cloud) are part of the fictional company. They are facts in the
  [Product Bible](copper-state-labs/product-bible.md) and rows in the `ai_tiers`
  table.
- **The models this app calls** are real Claude models listed in
  `lib/ai/models.ts`. Their cost is logged in `ai_calls`.

## Decisions

- **No environment variables required.** Every service is optional, so a fresh
  clone builds and deploys before any accounts are set up.
- **One AI wrapper.** Routing every call through `lib/ai/call.ts` gives one
  place to log cost and latency per module and feature.
- **No authentication or row-level security yet.** They arrive in a later
  module.

## Adding a module

When a module changes how the app fits together, add a section here:

```md
## Module N: <feature name>

**Summary:** one or two sentences: what this adds and why.

| Piece | Where | What it does |
|---|---|---|
| Page / route | `app/...` | |
| Components | `components/...` | |
| Data | `lib/copper/data/...` | Data files added |
| AI calls | `lib/ai/call.ts` (module, feature) | Model, prompt purpose, expected cost per call |

**Data flow:** user action → page → server code → database / model → response.

**Decisions and trade-offs:** what you chose, the alternatives, and why.

**Risks and open questions:** cost, privacy, accuracy or safety risks, and how
you handle them.
```

## Module 3 starter: Ask Copper

**Summary:** Ask Copper, the Module 2 shopping chatbot, finished: a floating
chat panel that answers prices, totals and stock with four tools and shows
each step. Module 3 teaches it to answer from the customer documents.

| Piece | Where | What it does |
|---|---|---|
| Component | `components/copper/ask-copper.tsx` | The launcher and chat panel, mounted from `app/page.tsx` and opened by the header's `#ask` link. Draws each answer as stations: the tools on offer, thinking, each tool call, then the reply |
| Server Action | `lib/copper/assistant/ask.ts` | `askCopper()`: streams the conversation with `callStream`, up to 5 steps, and sends each step back as a live `Progress` |
| Tools | `lib/copper/assistant/tools.ts` | `copperTools`: `get_products`, `get_prices`, `calculate_cost`, `check_availability` |
| Instructions | `lib/copper/assistant/instructions.ts` | `COPPER_INSTRUCTIONS`. Copper says it can't help yet with warranty, setup, troubleshooting or privacy |
| Data | `lib/copper/inventory.ts`, `lib/copper/documents.ts` | Stock from `lib/copper/data/inventory.json`; `DOCUMENTS`: the four customer documents and their PDF paths under `public/docs/`. The PDFs are added in class |
| AI calls | `{ module: 2, feature: "ask-copper" }` | One streamed call per question |

## Module 3: Document passages and embeddings

**Summary:** The four customer PDFs in `public/docs/` are split into passages
of a few sentences and embedded with Gemini, so Ask Copper can find the
passages that answer a question and cite their page.

| Piece | Where | What it does |
|---|---|---|
| Build script | `scripts/embed-docs.mjs` (`npm run embed-docs`) | Reads each PDF in `DOCUMENTS` page by page (with `unpdf`), splits pages with `splitPage()`, embeds every passage and writes the JSON. Re-run it when a PDF changes |
| Splitter | `lib/copper/split-passages.ts` | `splitPage()`: drops the footer lines, then groups sentences three at a time (at most ~600 characters) |
| Data | `lib/copper/data/passages.json`, `lib/copper/passages.ts` | `PASSAGES`: `documentId`, `title`, `page`, `text` (starts with the document title) and `embedding`. Importing it loads every passage into memory once per server |
| Tool | `lib/copper/assistant/tools.ts` | `search_docs`: embeds the question, ranks every passage by cosine similarity and returns the 5 closest with title, page, a `/docs/<file>.pdf#page=N` link and a score. The tool card lists them with links; the instructions tell Copper to use it for setup, troubleshooting, warranty and policy questions and to cite the page |
| Citations | `lib/copper/assistant/citations.ts`, `lib/copper/assistant/instructions.ts` | Copper answers document questions only from `search_docs`, ends every sentence with `[Title, p. N]`, and says "I couldn't find that in our support docs" otherwise. `splitCitations()` lets the panel link each citation to that PDF page; unknown titles stay plain text |
| AI calls | `callEmbedMany` in `lib/ai/call.ts`, `{ module: 3, feature: "embed-docs" }` | `gemini-embedding-2` at 768 dimensions. One call per run of the script, plus one `{ module: 3, feature: "search-docs" }` call per search. Google doesn't report embedding tokens, so the log's tokens and cost are null |

**Data flow:** PDF → pages → passages → Gemini embeddings → `passages.json` →
`PASSAGES` in memory. Question → `search_docs` → question embedding → 5
closest passages → Copper answers from them and cites the page.

**Decisions and trade-offs:** A JSON file in memory instead of a vector
database: about 120 passages is under 1 MB, so searching all of them is
instant and needs no new service. 768 dimensions instead of 3072 keeps the
file small with little loss in accuracy. The title goes at the start of each
passage so similar passages from different documents (Copper Home vs. Copper
Notes) embed differently.

**Risks and open questions:** Questions must be embedded with the same model
and dimensions (`EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`) or the search
returns nonsense. Tables lose their columns when turned into text. Embeddings match meaning
better than exact strings, so an error code like C-47 can rank below other
error-code passages (it was third in testing); keyword search alongside would fix that.

## Module 4 starter: Support page

**Summary:** An empty Support page titled "Refund Console", with Ask Copper
(as finished in Module 3) docked on the right. Module 4 builds refunds here: a
second agent, and a person approving the large ones.

| Piece | Where | What it does |
|---|---|---|
| Page | `app/support/page.tsx` | The "Refund Console" title and nothing else yet, linked from the header as Support |
| Chat panel | `components/copper/ask-copper.tsx` | With the `docked` prop it starts open and the page beside it stays clickable. It is the same single agent and tools as on the home page |

## Module 4: Refunds and the Refund agent

**Summary:** The Refund Console lists the customer's orders, an auto-refund
limit ($100 by default) and the refunds waiting for a person. In the chat,
Copper hands refund requests to a second agent, the Refund agent. Code refunds
anything at or under the limit on its own; anything larger waits until a
person clicks Approve or Reject, and the chat tells the customer what they
decided.

| Piece | Where | What it does |
|---|---|---|
| Page | `app/support/page.tsx` | Wraps the console and the docked chat in `RefundsProvider`, so both share one state |
| Console | `components/copper/refunds.tsx` | `RefundsProvider` (limit, order statuses, decisions; saved in `localStorage` as `copper-refunds`) and `RefundConsole`: the limit input, the "Waiting for your approval" queue with Approve / Reject, the orders table and a Reset demo button |
| Orders and rule | `lib/copper/orders.ts` | `getOrders()`: four orders priced from the catalog. `decideRefund()`: the rule, in code (at or under the limit → `refunded`, over → `pending_approval`, already handled → says so). `decisionMessage()`: what the Refund agent says after Approve / Reject |
| Hand-off | `lib/copper/assistant/ask.ts`, `tools.ts` | On the Support page Copper also gets `transfer_to_refund_agent`. Copper's stream stops at that call (`hasToolCall`) and a second stream starts with `REFUND_INSTRUCTIONS` and only `get_orders` and `request_refund`. Both run in one answer; the panel draws a hand-off station between them and labels the reply "Refund agent" |
| Chat panel | `components/copper/ask-copper.tsx` | Sends the console's limit and statuses with each question, applies each `request_refund` result to the console, and adds a Refund-agent message when a person decides |
| AI calls | `{ module: 2, feature: "ask-copper" }`, `{ module: 4, feature: "refund-agent" }` | One Copper stream (usually one step: the hand-off) plus one Refund-agent stream (`request_refund`, then the reply). Approve / Reject call no model |

**Data flow:** customer asks for a refund → Copper calls
`transfer_to_refund_agent` → Refund agent calls `request_refund` →
`decideRefund()` compares the catalog price with the limit → refunded, or
queued in the console → a person clicks Approve or Reject → the order's status
changes and the Refund agent's message appears in the chat.

**Decisions and trade-offs:** The model never decides a refund: it can only
ask, and code compares the amount with the limit, so a persuasive customer
can't talk it past the limit. A person makes the call above the limit. The
state lives in the browser instead of a database, so the server stays
stateless and works on Vercel with no new service; each visitor gets their
own demo. The Approve / Reject message is fixed text, not a model call: it is
always accurate and costs nothing.

**Risks and open questions:** The limit and order statuses come from the
browser, so a real store would keep them on the server and check who is
allowed to approve (authentication arrives in a later module). There is one
demo customer, and refunds aren't sent to a payment provider. Each refund
question costs two model calls' worth of steps, which matters on the free
Gemini tier.

# Devpost submission text (copy-paste)

## Project name
Duely: the AI agent that gets freelancers paid

## Tagline (short)
Bill clients in plain English, get paid on PayPal, auto-split earnings with collaborators, run monthly retainers through PayPal's Agent Toolkit, and let other AI agents transact through you over MCP.

## Inspiration
Freelancers and tiny studios lose hours to the money side of their work: writing invoices, sending links, chasing clients who "forgot", then manually paying collaborators their share once the client finally pays. We wanted an agent that doesn't just *suggest* what to do, but actually moves the money, safely.

## What it does
- **Chat-to-bill:** "Bill Ravi $450 for 3 landing pages, due Friday. Priya gets 30%." Gemini extracts line items, quantities, prices, currency, relative due dates, phone numbers and revenue splits, and creates a real **PayPal Orders v2** payment request with an itemized breakdown, a branded client pay page, and a ready-to-send WhatsApp/email message.
- **Auto-capture:** when the client pays, Duely captures immediately via the return URL, with a background poller and signature-verified PayPal webhooks as backup. It's idempotent under races.
- **Auto-split payouts:** collaborator shares are confirmed once, then paid automatically through **PayPal Payouts** the moment the client's payment completes. Batch status is tracked to COMPLETED.
- **AI payment chasing:** reminders written by the agent, escalating from friendly to firm to final based on history, with one-tap WhatsApp/email send.
- **Refunds and payouts by chat:** full or partial refunds via the **Payments v2** refund API; ad-hoc payouts to contractors.
- **Retainers with PayPal's official Agent Toolkit:** "Set up a $500 monthly retainer for Acme" makes Duely call the toolkit's `create_product`, `create_subscription_plan` and `create_subscription`, then hands back a subscription link. The client approves once and PayPal bills them automatically; Duely tracks the status with `show_subscription_details` and subscription webhooks.
- **Official PayPal tools inside the agent:** the agent also gets curated Agent Toolkit tools (`list_disputes`, `get_dispute`, `show_subscription_details`, `get_order`), so "Any open PayPal disputes?" is answered by PayPal's own tool. Toolkit actions that can't be undone (`cancel_subscription`, `accept_dispute_claim`) go through the same approval step as payouts.
- **Cash-flow insights:** outstanding, collected (net of refunds), overdue, top debtor, average days to pay.
- **Agent-to-agent commerce:** Duely is also an **MCP server**. Any AI agent (Claude Desktop, Cursor, or our demo "JobBoard" scheduling agent) can bill clients and request contractor payouts through Duely + PayPal.
- **Human in the loop:** refunds, payouts and splits, whether asked for by you or by an outside agent, never execute until the owner presses **Confirm**.

## How we built it
- **Backend:** Node.js (node:http + fetch) with a single dependency, PayPal's official **`@paypal/agent-toolkit`**. The PayPal REST client covers OAuth, Orders v2 create/get/capture, Payments v2 refunds, Payouts v1 create/status, and webhook signature verification, with `PayPal-Request-Id` idempotency.
- **PayPal Agent Toolkit:** used through its framework-agnostic `getTools()` / `handleToolCall()` interface, so its official tools plug straight into our own Gemini agent loop. We convert its zod-generated JSON schemas (`anyOf`, `null`, `$ref`) to the subset Gemini accepts, unwrap its double-encoded results, and surface its error shapes to the agent as plain errors.
- **AI:** Google **Gemini** native function calling via the `generateContent` REST API. We wrote a provider-agnostic agent loop (it also runs on Claude or OpenAI) with 16 tools: 10 of Duely's own plus 6 official PayPal Agent Toolkit tools. Each turn is grounded in a live snapshot of payment requests and today's date. Resilience: per-call timeouts, retries with backoff, automatic model fallback that remembers the healthy model, and a whole-turn retry only when no tool has run (so money actions are never duplicated).
- **Safety:** money-moving tools return a *pending action* instead of executing; the dashboard shows a confirmation card (tagged with the requesting agent for MCP calls).
- **MCP:** a dependency-free stdio JSON-RPC MCP server that maps Duely's tools to `tools/list` and `tools/call` and forwards them to Duely's tool API.
- **Frontend:** vanilla JS dashboard with **AG Grid Community** for the payment table, a live activity feed, payment toasts and rich chat cards.
- **Testing:** 14 end-to-end tests with a mock PayPal and scripted agent (full bill → pay → capture → auto-split → refund flow, webhook capture, idempotency, model fallback, and a real MCP session, retainers via a stand-in toolkit, approval-gating of official tools, and toolkit result parsing), plus `npm run smoke` and `npm run probe` for live sandbox checks.
- **Deploy:** Render blueprint (`render.yaml`).

## Challenges we ran into
- PayPal **Invoicing** wasn't enabled for our sandbox account, so we built the invoice experience on **Orders v2** (itemized breakdown, invoice_id, a branded pay page). That turned out to be a better fit for instant capture and auto-split.
- Free-tier Gemini models were frequently overloaded or retired mid-hackathon. We added timeouts, backoff, automatic model fallback and short-circuiting of unnecessary round trips, which took typical turns from 50s+ down to around 3–10s.
- Making capture idempotent across the return URL, the poller and webhooks firing at the same time.
- Wiring PayPal's Agent Toolkit into a Gemini agent: its tool schemas needed converting for Gemini, its results arrive double-encoded, and some tools need permissions the sandbox app doesn't have (Reporting) or aren't available in sandbox (merchant insights). We probed each tool live and only offer the agent the ones that work.

## Accomplishments we're proud of
- A complete, real sandbox money loop: bill → client pays → capture → **automatic payout to a collaborator** → refund, all started from natural language.
- Agent-to-agent commerce with a human approving every payout.
- One dependency (PayPal's own toolkit): judges can run it with Node and a single `npm install`.

## What we learned
Agents are only useful for money if they're grounded and guarded: grounded in live state (so "refund Ravi" hits the right order) and guarded by explicit human confirmation for anything that sends funds out.

## What's next
Auto-splitting retainer payments as PayPal bills them, dispute evidence drafting, scheduled auto-reminders, multi-user accounts, and publishing the MCP server so any freelancer's AI assistant can bill through PayPal.

## Built with
paypal-agent-toolkit, paypal-orders-api, paypal-subscriptions, paypal-payouts, paypal-payments-refunds, paypal-disputes, paypal-webhooks, paypal-sandbox, gemini, google-ai-studio, function-calling, mcp, node.js, javascript, ag-grid, render

## Tools used (AI and sponsor tools section)
- **Google Gemini** (`gemini-flash-lite-latest`, with fallbacks) via the Gemini API: powers the Duely agent. It parses billing requests into structured PayPal orders, resolves dates, writes client messages and tone-escalating reminders, answers cash-flow questions, and decides which PayPal tool to call (function calling). It also powers the separate "JobBoard" demo agent that transacts through Duely over MCP.
- **PayPal Agent Toolkit** (`@paypal/agent-toolkit` v1.11): PayPal's official AI tools. Duely uses `create_product`, `create_subscription_plan`, `create_subscription`, `show_subscription_details` and `cancel_subscription` for retainers, and gives the agent `list_disputes`, `get_dispute`, `get_order` and an approval-gated `accept_dispute_claim`.
- **Model Context Protocol (MCP):** Duely's MCP server exposes its PayPal tools to other AI agents.
- **AG Grid Community:** the payment-requests table (sorting, filtering, quick search, custom status and action cells).
- **Render:** hosting via the included `render.yaml` blueprint.
- **Claude (Anthropic):** used as a coding assistant during development.

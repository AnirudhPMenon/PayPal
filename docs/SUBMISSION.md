# Devpost submission text (copy-paste)

## Project name
Duely: the AI agent that gets freelancers paid

## Tagline (short)
Bill clients in plain English, get paid on PayPal, auto-split earnings with collaborators, and let other AI agents transact through you over MCP.

## Inspiration
Freelancers and tiny studios lose hours to the money side of their work: writing invoices, sending links, chasing clients who "forgot", then manually paying collaborators their share once the client finally pays. We wanted an agent that doesn't just *suggest* what to do, but actually moves the money, safely.

## What it does
- **Chat-to-bill:** "Bill Ravi $450 for 3 landing pages, due Friday. Priya gets 30%." Gemini extracts line items, quantities, prices, currency, relative due dates, phone numbers and revenue splits, and creates a real **PayPal Orders v2** payment request with an itemized breakdown, a branded client pay page, and a ready-to-send WhatsApp/email message.
- **Auto-capture:** when the client pays, Duely captures immediately via the return URL, with a background poller and signature-verified PayPal webhooks as backup. It's idempotent under races.
- **Auto-split payouts:** collaborator shares are confirmed once, then paid automatically through **PayPal Payouts** the moment the client's payment completes. Batch status is tracked to COMPLETED.
- **AI payment chasing:** reminders written by the agent, escalating from friendly to firm to final based on history, with one-tap WhatsApp/email send.
- **Refunds and payouts by chat:** full or partial refunds via the **Payments v2** refund API; ad-hoc payouts to contractors.
- **Cash-flow insights:** outstanding, collected (net of refunds), overdue, top debtor, average days to pay.
- **Agent-to-agent commerce:** Duely is also an **MCP server**. Any AI agent (Claude Desktop, Cursor, or our demo "JobBoard" scheduling agent) can bill clients and request contractor payouts through Duely + PayPal.
- **Human in the loop:** refunds, payouts and splits, whether asked for by you or by an outside agent, never execute until the owner presses **Confirm**.

## How we built it
- **Backend:** Node.js with **zero dependencies** (node:http + fetch). The PayPal REST client covers OAuth, Orders v2 create/get/capture, Payments v2 refunds, Payouts v1 create/status, and webhook signature verification, with `PayPal-Request-Id` idempotency.
- **AI:** Google **Gemini** native function calling via the `generateContent` REST API. We wrote a provider-agnostic agent loop (it also runs on Claude or OpenAI) with 8 tools. Each turn is grounded in a live snapshot of payment requests and today's date. Resilience: per-call timeouts, retries with backoff, automatic model fallback that remembers the healthy model, and a whole-turn retry only when no tool has run (so money actions are never duplicated).
- **Safety:** money-moving tools return a *pending action* instead of executing; the dashboard shows a confirmation card (tagged with the requesting agent for MCP calls).
- **MCP:** a dependency-free stdio JSON-RPC MCP server that maps Duely's tools to `tools/list` and `tools/call` and forwards them to Duely's tool API.
- **Frontend:** vanilla JS dashboard with **AG Grid Community** for the payment table, a live activity feed, payment toasts and rich chat cards.
- **Testing:** 10 end-to-end tests with a mock PayPal and scripted agent (full bill → pay → capture → auto-split → refund flow, webhook capture, idempotency, model fallback, and a real MCP session), plus `npm run smoke` for live sandbox + AI checks.
- **Deploy:** Render blueprint (`render.yaml`).

## Challenges we ran into
- PayPal **Invoicing** wasn't enabled for our sandbox account, so we built the invoice experience on **Orders v2** (itemized breakdown, invoice_id, a branded pay page). That turned out to be a better fit for instant capture and auto-split.
- Free-tier Gemini models were frequently overloaded or retired mid-hackathon. We added timeouts, backoff, automatic model fallback and short-circuiting of unnecessary round trips, which took typical turns from 50s+ down to around 3–10s.
- Making capture idempotent across the return URL, the poller and webhooks firing at the same time.

## Accomplishments we're proud of
- A complete, real sandbox money loop: bill → client pays → capture → **automatic payout to a collaborator** → refund, all started from natural language.
- Agent-to-agent commerce with a human approving every payout.
- Zero dependencies: judges can run it with Node alone.

## What we learned
Agents are only useful for money if they're grounded and guarded: grounded in live state (so "refund Ravi" hits the right order) and guarded by explicit human confirmation for anything that sends funds out.

## What's next
PayPal Subscriptions for retainers, dispute triage with the Disputes API, scheduled auto-reminders, multi-user accounts, and publishing the MCP server so any freelancer's AI assistant can bill through PayPal.

## Built with
paypal-orders-api, paypal-payouts, paypal-payments-refunds, paypal-webhooks, paypal-sandbox, gemini, google-ai-studio, function-calling, mcp, node.js, javascript, ag-grid, render

## Tools used (AI and sponsor tools section)
- **Google Gemini** (`gemini-flash-lite-latest`, with fallbacks) via the Gemini API: powers the Duely agent. It parses billing requests into structured PayPal orders, resolves dates, writes client messages and tone-escalating reminders, answers cash-flow questions, and decides which PayPal tool to call (function calling). It also powers the separate "JobBoard" demo agent that transacts through Duely over MCP.
- **Model Context Protocol (MCP):** Duely's MCP server exposes its PayPal tools to other AI agents.
- **AG Grid Community:** the payment-requests table (sorting, filtering, quick search, custom status and action cells).
- **Render:** hosting via the included `render.yaml` blueprint.
- **Claude (Anthropic):** used as a coding assistant during development.

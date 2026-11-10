#!/usr/bin/env node
// Duely MCP server: lets ANY AI agent (Claude Desktop, Cursor, your own agent…) bill clients,
// check payments, chase debtors and request payouts through Duely + PayPal.
// Agent-to-agent commerce with a human in the loop: refunds, payouts and splits requested by an
// external agent are queued until the Duely owner presses Confirm in their dashboard.
//
// Transport: MCP over stdio (newline-delimited JSON-RPC 2.0). Zero dependencies.
// Config (env): DUELY_URL (default http://localhost:3000), DUELY_API_KEY (if the server sets one),
//               DUELY_AGENT_NAME (defaults to the connecting client's name).

import readline from "node:readline";

const BASE = (process.env.DUELY_URL || "http://localhost:3000").replace(/\/$/, "");
const KEY = process.env.DUELY_API_KEY || "";
let agentName = process.env.DUELY_AGENT_NAME || "";
let toolCache = null;

const log = (...a) => console.error("[duely-mcp]", ...a); // stdout is reserved for protocol messages
const write = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => write({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => write({ jsonrpc: "2.0", id, error: { code, message } });

const FRIENDLY = { "claude-ai": "Claude Desktop", claude: "Claude", cursor: "Cursor", "cursor-vscode": "Cursor" };

async function duely(path, body) {
  const res = await fetch(BASE + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", "x-agent-name": agentName || "External agent", ...(KEY ? { "x-duely-key": KEY } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Duely returned ${res.status}`);
  return data;
}

async function listTools() {
  if (!toolCache) {
    const { tools } = await duely("/api/tools");
    toolCache = tools.map((t) => ({
      name: t.name,
      description: t.description + (["refund_payment", "send_payout"].includes(t.name) || t.name === "create_payment_request" ? " Money-moving actions are queued for the Duely owner's approval." : ""),
      inputSchema: t.parameters,
    }));
  }
  return toolCache;
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    switch (method) {
      case "initialize": {
        if (!agentName) {
          const n = params?.clientInfo?.name || "External agent";
          agentName = FRIENDLY[n] || n;
        }
        return reply(id, {
          protocolVersion: params?.protocolVersion || "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "duely", title: "Duely: PayPal billing agent", version: "1.0.0" },
          instructions:
            "Duely bills clients and moves money through PayPal for a freelancer. Use create_payment_request to bill someone, check_payment_status to see if they paid, save_reminder to chase, get_insights for cash flow. Refunds, payouts and revenue splits are queued until the human owner confirms in the Duely dashboard.",
        });
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        return;
      case "ping":
        return reply(id, {});
      case "tools/list":
        return reply(id, { tools: await listTools() });
      case "tools/call": {
        const { result } = await duely(`/api/tools/${encodeURIComponent(params.name)}`, params.arguments || {});
        return reply(id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: Boolean(result?.error),
        });
      }
      default:
        if (isRequest) return fail(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    log(e.message);
    if (method === "tools/call") return reply(id, { content: [{ type: "text", text: `Duely error: ${e.message}. Is the Duely server running at ${BASE}?` }], isError: true });
    if (isRequest) fail(id, -32603, e.message);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  handle(msg);
});
log(`ready, forwarding to ${BASE}`);

// Agent-to-agent commerce demo.
// A separate AI agent ("JobBoard scheduling agent") marks a job complete and settles the money by
// talking to Duely over MCP: it bills the client and asks to pay the subcontractor. Duely queues the
// payout for the human owner's approval in the dashboard.
//
// Run (with `npm start` running in another terminal):
//   npm run agent-demo
//   npm run agent-demo -- "Job #88 for Meera's bakery is done: website fixes, 4 hours at $35/hr. Pay Sam (sam@example.com) $60 for his part."
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgent } from "../lib/agent.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const task =
  process.argv.slice(2).join(" ") ||
  `Job #42 for Ravi Kumar is marked COMPLETE: "Fix checkout bug + deploy", 3 hours at $50/hr, due in 7 days. ` +
    `Our subcontractor Sam did half the work. Pay him $75 via PayPal (${process.env.RECIPIENT_EMAIL || "sam@example.com"}).`;

// --- Minimal MCP client over stdio ---
const mcp = spawn(process.execPath, [path.join(root, "mcp", "duely-mcp.mjs")], {
  env: { ...process.env, DUELY_AGENT_NAME: "JobBoard agent" },
  stdio: ["pipe", "pipe", "inherit"],
});
const waiting = new Map();
let buf = "";
let nextId = 0;
mcp.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    waiting.get(msg.id)?.(msg);
  }
});
const rpc = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    waiting.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

const c = { dim: "\x1b[2m", bold: "\x1b[1m", cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", off: "\x1b[0m" };

try {
  await rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "jobboard-agent", version: "1.0" }, capabilities: {} });
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const { tools } = await rpc("tools/list", {});
  console.log(`\n${c.bold}🤖 JobBoard agent${c.off} connected to ${c.cyan}Duely${c.off} over MCP · ${tools.length} tools available\n`);
  console.log(`${c.dim}Task:${c.off} ${task}\n`);

  const agent = createAgent(process.env);
  const text = await agent.run({
    system: `You are JobBoard, a scheduling assistant for a small agency. When a job is complete you settle the money using the Duely tools (PayPal):
1) bill the client with create_payment_request (use the exact hours/rates; convert relative due dates; today is ${new Date().toISOString().slice(0, 10)}),
2) pay subcontractors with send_payout.
Payouts are queued for the agency owner's approval in Duely, so report them as "awaiting approval", not as sent. Finish with a 2-3 line summary including the client's share link.`,
    history: [],
    userMessage: task,
    tools: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema })),
    execute: async (name, args) => {
      console.log(`${c.yellow}→ MCP tools/call ${name}${c.off} ${c.dim}${JSON.stringify(args)}${c.off}`);
      const res = await rpc("tools/call", { name, arguments: args });
      const out = res.structuredContent ?? res.content?.[0]?.text;
      const status = out?.status || (out?.ok ? "ok" : out?.error ? "error: " + out.error : "done");
      console.log(`${c.green}← ${status}${c.off}\n`);
      return out;
    },
  });
  console.log(`${c.bold}JobBoard agent:${c.off} ${text}\n`);
  console.log(`${c.dim}Open the Duely dashboard: the bill is live, and the payout is waiting for your Confirm.${c.off}\n`);
} catch (e) {
  console.error("Demo failed:", e.message);
  process.exitCode = 1;
} finally {
  mcp.kill();
}

// "JobBoard": a separate AI agent that settles a finished job by talking to Duely over MCP.
// Used by the Agents page (streamed to the browser) and by `npm run agent-demo` (printed to a terminal).
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgent } from "./agent.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export function defaultJobTask(email) {
  return (
    `Job #42 for Ravi Kumar is marked complete: "Fix checkout bug and deploy", 3 hours at $50/hr, due in 7 days. ` +
    `Our subcontractor Sam did half the work. Pay him $75 via PayPal (${email || "sam@example.com"}).`
  );
}

// onEvent receives { type: "connected" | "call" | "result" | "done" | "error", ... }
export async function runJobBoard({ task, env = process.env, duelyUrl, onEvent = () => {}, agent: agentOverride = null }) {
  const mcp = spawn(process.execPath, [path.join(ROOT, "mcp", "duely-mcp.mjs")], {
    env: { ...process.env, DUELY_URL: duelyUrl, DUELY_AGENT_NAME: "JobBoard agent", DUELY_API_KEY: env.DUELY_API_KEY || "" },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const waiting = new Map();
  let buf = "";
  let nextId = 0;
  mcp.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const msg = JSON.parse(line);
        waiting.get(msg.id)?.(msg);
      } catch {
        /* ignore non-protocol output */
      }
    }
  });
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => reject(new Error(`MCP ${method} timed out`)), 60000);
      waiting.set(id, (m) => {
        clearTimeout(timer);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      });
      mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

  try {
    await rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "jobboard-agent", version: "1.0" }, capabilities: {} });
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const { tools } = await rpc("tools/list", {});
    onEvent({ type: "connected", tools: tools.length, task });

    const agent = agentOverride || createAgent(env);
    const text = await agent.run({
      system: `You are JobBoard, a scheduling assistant for a small agency. When a job is complete you settle the money using the Duely tools (PayPal):
1) bill the client with create_payment_request (use the exact hours and rates; convert relative due dates; today is ${new Date().toISOString().slice(0, 10)}),
2) pay subcontractors with send_payout.
Payouts are queued for the agency owner's approval in Duely, so report them as waiting for approval, not as sent. Finish with a 2-3 line summary that includes the client's share link.`,
      history: [],
      userMessage: task,
      tools: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema })),
      execute: async (name, args) => {
        onEvent({ type: "call", tool: name, args });
        const res = await rpc("tools/call", { name, arguments: args });
        const out = res.structuredContent ?? res.content?.[0]?.text;
        onEvent({ type: "result", tool: name, status: out?.status || (out?.ok ? "ok" : out?.error ? "error" : "done"), error: out?.error, share: out?.share_link });
        return out;
      },
    });
    onEvent({ type: "done", text });
    return text;
  } catch (e) {
    onEvent({ type: "error", message: e.message });
    throw e;
  } finally {
    mcp.kill();
  }
}

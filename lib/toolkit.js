// PayPal's official Agent Toolkit (@paypal/agent-toolkit), used through its framework-agnostic
// interface: getTools() gives JSON-schema tool definitions, handleToolCall() executes them.
// Duely uses it for recurring retainers (Catalog + Subscriptions) and hands a curated set of the
// official tools straight to its AI agent. Tools that cancel or concede something are approval-gated.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Official tools given directly to the agent.
// list_transactions needs the Reporting permission and get_merchant_insights isn't available in sandbox,
// so they're only offered when PAYPAL_TOOLKIT_EXTRA=1 (e.g. a live app with Reporting enabled).
export const OFFICIAL_READ_TOOLS = ["list_disputes", "get_dispute", "show_subscription_details", "get_order", ...(process.env.PAYPAL_TOOLKIT_EXTRA === "1" ? ["list_transactions", "get_merchant_insights"] : [])];
// Official tools that need the owner's approval before they run.
export const OFFICIAL_GUARDED_TOOLS = ["cancel_subscription", "accept_dispute_claim"];

const ACTIONS = {
  products: { create: true, list: true, show: true },
  subscriptionPlans: { create: true, list: true, show: true },
  subscriptions: { create: true, show: true, cancel: true },
  disputes: { list: true, get: true, create: true },
  transactions: { list: true },
  insights: { get: true },
  orders: { get: true },
};

export class ToolkitError extends Error {}

// Turn whatever handleToolCall returned into data, or throw a readable error.
// The toolkit returns JSON that is sometimes encoded twice (a JSON string inside JSON), and reports
// failures in several shapes: {"ok":false,...}, {"error":{...}}, PayPal error bodies, or plain text.
export function parseToolkitResult(res) {
  let data = (res?.content || []).map((c) => c.text ?? "").join("\n").trim();
  for (let i = 0; i < 3 && typeof data === "string"; i++) {
    const t = data.trim();
    if (!/^[\[{"]/.test(t)) break;
    try {
      data = JSON.parse(t);
    } catch {
      break;
    }
  }
  if (typeof data === "string") {
    if (/^(error|failed|an error)/i.test(data) || /not_authorized|permission_denied|insufficient permissions|invalid_request|unprocessable/i.test(data)) throw new ToolkitError(data.slice(0, 400));
    return { result: data };
  }
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const err =
      data.ok === false || (typeof data.status === "number" && data.status >= 400)
        ? data
        : data.error || (data.name && data.message && (data.debug_id || data.details) ? data : null);
    if (err) {
      const msg = typeof err === "string" ? err : [err.code || err.name, err.message, err.details?.[0]?.description].filter(Boolean).join(": ");
      throw new ToolkitError((msg || "PayPal Agent Toolkit call failed").slice(0, 400));
    }
  }
  return data;
}

export function toolkitVersion() {
  try {
    const entry = require.resolve("@paypal/agent-toolkit/bedrock");
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(entry), "..", "package.json"), "utf8"));
    return pkg.version;
  } catch {
    return null;
  }
}

export function createOfficialToolkit({ mode = "sandbox", clientId, clientSecret, log = console.log } = {}) {
  if (mode === "mock" || !clientId || !clientSecret) return null;
  let mod;
  try {
    mod = require("@paypal/agent-toolkit/bedrock");
  } catch {
    log("  ⚠ @paypal/agent-toolkit not installed. Run `npm install` to enable retainers and official PayPal tools.");
    return null;
  }
  const tk = new mod.PayPalAgentToolkit({ clientId, clientSecret, configuration: { actions: ACTIONS, context: { sandbox: mode !== "live" } } });
  const defs = new Map(
    tk.getTools().map((t) => [t.toolSpec.name, { name: t.toolSpec.name, description: t.toolSpec.description.trim(), parameters: t.toolSpec.inputSchema.json, official: true }])
  );
  let n = 0;
  return {
    version: toolkitVersion(),
    has: (name) => defs.has(name),
    agentTools: () => [...OFFICIAL_READ_TOOLS, ...OFFICIAL_GUARDED_TOOLS].filter((x) => defs.has(x)).map((x) => defs.get(x)),
    async call(name, input = {}) {
      const t0 = Date.now();
      const res = await tk.handleToolCall({ toolUseId: `duely-${Date.now()}-${++n}`, name, input });
      try {
        const data = parseToolkitResult(res);
        log(`  [toolkit] ${name} → ok in ${Date.now() - t0}ms`);
        return data;
      } catch (e) {
        log(`  [toolkit] ${name} → ${e.message.slice(0, 160)}`);
        throw e;
      }
    },
  };
}

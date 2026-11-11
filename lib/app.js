// HTTP layer. Zero dependencies: node:http + static files.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toolDefs, agentToolDefs, createToolRunner } from "./tools.js";
import { buildSystemPrompt } from "./agent.js";
import { createService, fmt } from "./service.js";
import { pages } from "./pages.js";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };

export function createApp({ db, paypal, agent, config, toolkit = null }) {
  const service = createService({ db, paypal, config, toolkit });
  const tools = createToolRunner({ db, service, toolkit });
  const agentTools = agentToolDefs(toolkit);

  function state() {
    const d = db.data;
    return {
      requests: d.requests.map(service.view),
      retainers: d.retainers,
      insights: service.insights(),
      events: d.events.slice(0, 40),
      chat: d.chat.slice(-60),
      pendingActions: d.pendingActions,
      config: { businessName: config.businessName, provider: agent.provider, model: agent.model, paypalMode: paypal.mode, currency: config.defaultCurrency, publicUrl: config.publicUrl, agentToolkit: toolkit ? toolkit.version || "installed" : null },
    };
  }

  let chatBusy = false;

  async function chat(message) {
    const d = db.data;
    const history = d.chat.slice(-14).map((m) => ({ role: m.role, text: m.text }));
    d.chat.push({ role: "user", text: message, at: new Date().toISOString() });
    db.save();
    const cards = [];
    const system = buildSystemPrompt({
      businessName: config.businessName,
      ownerName: config.ownerName,
      defaultCurrency: config.defaultCurrency,
      today: new Date().toISOString().slice(0, 10) + ` (${new Date().toLocaleDateString("en-US", { weekday: "long" })})`,
      requests: d.requests.slice(0, 30).map((r) => tools.compact(service.view(r))),
      retainers: d.retainers.slice(0, 20).map(tools.compactRetainer),
      toolkit: Boolean(toolkit),
    });
    let text;
    let error = false;
    try {
      console.log(`\n[chat] ${message.slice(0, 80)}`);
      text = await agent.run({
        system,
        history,
        userMessage: message,
        tools: agentTools,
        execute: async (name, args) => {
          const out = await tools.execute(name, args, cards);
          console.log(`  [tool] ${name} → ${out.error ? "error: " + out.error : out.status || "ok"}`);
          return out;
        },
      });
    } catch (e) {
      console.log(`  [chat] failed: ${e.message}`);
      text = e.message;
      error = true;
    }
    const reply = { role: "assistant", text: text || "Done.", cards, at: new Date().toISOString(), ...(error ? { error: true } : {}) };
    d.chat.push(reply);
    db.save();
    return reply;
  }

  async function handleWebhook(headers, event) {
    if (config.webhookId && paypal.mode !== "mock") {
      const ok = await paypal.verifyWebhook(headers, event, config.webhookId).catch(() => false);
      if (!ok) return { status: 400, body: { error: "signature verification failed" } };
    }
    const type = event.event_type;
    const res = event.resource || {};
    if (type === "CHECKOUT.ORDER.APPROVED") {
      const r = db.findByOrderId(res.id);
      if (r) await service.captureRequest(r);
    } else if (type === "PAYMENT.CAPTURE.COMPLETED") {
      const orderId = res.supplementary_data?.related_ids?.order_id;
      const r = (orderId && db.findByOrderId(orderId)) || db.findRequest(res.invoice_id || res.custom_id || "");
      if (r) await service.syncRequest(r);
    } else if (type?.startsWith("BILLING.SUBSCRIPTION")) {
      const r = db.findRetainer(res.id || "");
      if (r) await service.syncRetainer(r);
    } else if (type?.startsWith("PAYMENT.PAYOUTS")) {
      for (const r of db.data.requests.filter((x) => x.splits.some((s) => s.status === "sent"))) await service.syncRequest(r);
    }
    db.log("webhook", `PayPal webhook: ${type}`);
    return { status: 200, body: { ok: true } };
  }

  // Background poller: catches payments when there's no webhook (e.g. running on localhost).
  let polling = false;
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const open = db.data.requests.filter((r) => r.status === "awaiting_payment" || r.splits.some((s) => s.status === "sent")).slice(0, 15);
      for (const r of open) await service.syncRequest(r).catch(() => {});
      const subs = db.data.retainers.filter((r) => ["APPROVAL_PENDING", "APPROVED", "ACTIVE", "SUSPENDED"].includes(r.status)).slice(0, 10);
      for (const r of subs) await service.syncRetainer(r).catch(() => {});
    } finally {
      polling = false;
    }
  }

  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  function send(res, status, body, headers = {}) {
    if (typeof body === "object" && !(body instanceof Buffer)) {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    } else {
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", ...headers });
      res.end(body);
    }
  }

  function serveStatic(res, urlPath) {
    const file = path.normalize(path.join(PUBLIC_DIR, urlPath === "/" ? "index.html" : urlPath));
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    fs.createReadStream(file).pipe(res);
    return true;
  }

  async function handler(req, res) {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    try {
      if (req.method === "GET" && p === "/api/state") return send(res, 200, state());
      if (req.method === "GET" && p === "/healthz") return send(res, 200, { ok: true });

      if (req.method === "POST" && p === "/api/chat") {
        const { message } = await readBody(req);
        if (!message?.trim()) return send(res, 400, { error: "message is required" });
        if (chatBusy) return send(res, 409, { error: "Still working on your last message. One moment.", state: state() });
        chatBusy = true;
        try {
          const reply = await chat(message.trim().slice(0, 2000));
          return send(res, 200, { reply, state: state() });
        } finally {
          chatBusy = false;
        }
      }

      let m;

      // Tool API for external AI agents (used by the Duely MCP server: agent-to-agent commerce).
      // Money-moving tools still only create a pending action the owner must confirm in the dashboard.
      if (req.method === "GET" && p === "/api/tools") return send(res, 200, { tools: toolDefs });
      if (req.method === "POST" && (m = p.match(/^\/api\/tools\/(\w+)$/))) {
        if (config.apiKey && req.headers["x-duely-key"] !== config.apiKey) return send(res, 401, { error: "invalid or missing x-duely-key" });
        const def = toolDefs.find((t) => t.name === m[1]);
        if (!def) return send(res, 404, { error: `unknown tool ${m[1]}` });
        const agentName = String(req.headers["x-agent-name"] || "External agent").replace(/[^\w .()-]/g, "").slice(0, 60) || "External agent";
        const args = await readBody(req);
        const cards = [];
        const result = await tools.execute(def.name, args, cards, { source: agentName });
        const pendingOk = result.status === "awaiting_user_confirmation";
        db.log("agent", `${agentName} used ${def.name.replace(/_/g, " ")} over MCP${pendingOk ? ", waiting for your approval" : result.error ? ` (error: ${result.error})` : ""}`);
        if (cards.length || result.error) {
          const label = def.name.replace(/_/g, " ");
          const text = result.error
            ? `Tried to ${label}: ${result.error}`
            : pendingOk
              ? `Asked to ${label}. This needs your approval.`
              : `Used Duely to ${label}.`;
          db.data.chat.push({ role: "assistant", text, cards, at: new Date().toISOString(), source: agentName, ...(result.error ? { error: true } : {}) });
          db.save();
        }
        return send(res, 200, { result });
      }

      if (req.method === "POST" && (m = p.match(/^\/api\/actions\/([\w-]+)\/confirm$/))) {
        try {
          const { action, result, cards } = await tools.confirm(m[1]);
          const text = result.error ? result.error : `Approved. ${action.summary}`;
          db.data.chat.push({ role: "assistant", text, cards, at: new Date().toISOString(), ...(result.error ? { error: true } : {}) });
          db.save();
          return send(res, 200, { ok: !result.error, state: state() });
        } catch (e) {
          db.data.chat.push({ role: "assistant", text: e.message, error: true, at: new Date().toISOString() });
          db.save();
          return send(res, 200, { ok: false, error: e.message, state: state() });
        }
      }
      if (req.method === "POST" && (m = p.match(/^\/api\/actions\/([\w-]+)\/cancel$/))) {
        const a = tools.dismiss(m[1]);
        if (a) {
          db.data.chat.push({ role: "assistant", text: `Declined. Nothing was sent.`, at: new Date().toISOString() });
          db.save();
        }
        return send(res, 200, { ok: true, state: state() });
      }
      if (req.method === "POST" && (m = p.match(/^\/api\/requests\/([\w-]+)\/sync$/))) {
        const r = db.findRequest(m[1]);
        if (!r) return send(res, 404, { error: "not found" });
        await service.syncRequest(r);
        return send(res, 200, { ok: true, state: state() });
      }
      if (req.method === "POST" && p === "/api/reset") {
        db.reset();
        return send(res, 200, { ok: true, state: state() });
      }

      // PayPal redirects the client here after approval → capture immediately.
      if (req.method === "GET" && p === "/paypal/return") {
        const r = db.findByOrderId(url.searchParams.get("token"));
        if (!r) return send(res, 404, pages.message("Payment not found", "We couldn't match this payment. If you were charged, the merchant will see it shortly."));
        try {
          await service.captureRequest(r);
        } catch (e) {
          return send(res, 500, pages.message("Something went wrong", e.message));
        }
        res.writeHead(302, { Location: `/pay/${r.id}?thanks=1` });
        return res.end();
      }

      // PayPal sends the client here after approving a retainer subscription.
      if (req.method === "GET" && p === "/retainer/return") {
        const r = db.findRetainer(url.searchParams.get("subscription_id") || "");
        if (!r) return send(res, 404, pages.message("Subscription not found", "We couldn't match this subscription. If you approved it, the business will see it shortly."));
        await service.syncRetainer(r).catch(() => {});
        const per = r.interval.toLowerCase();
        return send(
          res,
          200,
          r.status === "ACTIVE" || r.status === "APPROVED"
            ? pages.message("You're all set", `Your ${fmt(r.amountCents, r.currency)} per ${per} retainer with ${config.businessName} is approved. PayPal will bill it automatically each ${per}.`)
            : pages.message("Almost done", "PayPal is confirming your subscription. You can close this page.")
        );
      }

      // Client-facing invoice page
      if (req.method === "GET" && (m = p.match(/^\/pay\/([\w-]+)$/))) {
        const r = db.findRequest(m[1]);
        if (!r) return send(res, 404, pages.message("Not found", "This payment request doesn't exist."));
        return send(res, 200, pages.invoice(service.view(r), config, { thanks: url.searchParams.has("thanks"), cancelled: url.searchParams.has("cancelled"), fmt }));
      }

      if (req.method === "POST" && p === "/webhooks/paypal") {
        const out = await handleWebhook(req.headers, await readBody(req));
        return send(res, out.status, out.body);
      }

      // Mock checkout (tests/offline demo only)
      if (paypal.mode === "mock" && req.method === "GET" && (m = p.match(/^\/mock-checkout\/(\w+)$/))) {
        paypal.approve(m[1]);
        res.writeHead(302, { Location: `/paypal/return?token=${m[1]}&PayerID=MOCKPAYER` });
        return res.end();
      }

      if (req.method === "GET" && serveStatic(res, p)) return;
      return send(res, 404, { error: "not found" });
    } catch (e) {
      console.error(e);
      return send(res, 500, { error: e.message });
    }
  }

  return { handler, poll, service, tools, chat, state, handleWebhook };
}

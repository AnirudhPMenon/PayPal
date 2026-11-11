// End-to-end tests with mock PayPal and a scripted "AI" (no network, no keys needed).
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createDb } from "../lib/db.js";
import { createPayPal, buildOrderBody } from "../lib/paypal.js";
import { createAgent, normalizeHistory } from "../lib/agent.js";
import { createApp } from "../lib/app.js";
import { normalizeItems, computeSplits } from "../lib/service.js";

function setup(script) {
  const config = { publicUrl: "http://localhost:0", businessName: "Test Studio", defaultCurrency: "USD" };
  const db = createDb(null);
  const paypal = createPayPal({ mode: "mock", publicUrl: config.publicUrl });
  // Scripted agent: calls the tools we tell it to, like a real model would.
  const agent = createAgent({}, { provider: "scripted", model: "test", run: async ({ execute, userMessage }) => script(execute, userMessage) });
  const app = createApp({ db, paypal, agent, config });
  return { db, paypal, app, config };
}

async function serve(app) {
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  return { base, close: () => server.close() };
}

test("line items: fractional hours fold into one line, prices to cents", () => {
  const items = normalizeItems([{ name: "API work", quantity: 12.5, unit_price: 40 }, { name: "Setup", unit_price: 99.99 }]);
  assert.equal(items[0].quantity, 1);
  assert.equal(items[0].unitCents, 50000);
  assert.equal(items[1].unitCents, 9999);
  assert.throws(() => normalizeItems([]), /At least one/);
  assert.throws(() => normalizeItems([{ name: "x", unit_price: -5 }]), /Invalid price/);
});

test("splits validate email and total under 100%", () => {
  const s = computeSplits([{ name: "Priya", email: "p@x.com", percent: 30 }], 45000, "USD");
  assert.equal(s[0].cents, 13500);
  assert.throws(() => computeSplits([{ name: "A", email: "bad", percent: 10 }], 100, "USD"), /valid PayPal email/);
  assert.throws(() => computeSplits([{ name: "A", email: "a@x.com", percent: 60 }, { name: "B", email: "b@x.com", percent: 40 }], 100, "USD"), /less than 100/);
});

test("order body matches PayPal Orders v2 shape", () => {
  const req = { id: "DU-1", client: { name: "Ravi" }, currency: "USD", items: normalizeItems([{ name: "Page", quantity: 3, unit_price: 150 }]) };
  const body = buildOrderBody(req, { returnUrl: "http://r", cancelUrl: "http://c", brandName: "B" });
  assert.equal(body.intent, "CAPTURE");
  assert.equal(body.purchase_units[0].amount.value, "450.00");
  assert.equal(body.purchase_units[0].amount.breakdown.item_total.value, "450.00");
  assert.equal(body.purchase_units[0].items[0].quantity, "3");
  assert.equal(body.purchase_units[0].invoice_id, "DU-1");
  assert.equal(body.payment_source.paypal.experience_context.shipping_preference, "NO_SHIPPING");
});

test("history normalization alternates roles and starts with user", () => {
  const h = normalizeHistory([{ role: "assistant", text: "hi" }, { role: "user", text: "a" }, { role: "user", text: "b" }, { role: "assistant", text: "c" }]);
  assert.deepEqual(h.map((x) => x.role), ["user", "assistant"]);
  assert.equal(h[0].text, "a\n\nb");
});

test("full flow: chat → request → client pays → capture → auto-split payout → refund", async () => {
  const { app, db } = setup(async (execute, msg) => {
    if (msg.startsWith("Bill")) {
      const out = await execute("create_payment_request", {
        client_name: "Ravi",
        items: [{ name: "Landing page", quantity: 3, unit_price: 150 }],
        due_date: "2099-01-01",
        splits: [{ name: "Priya", email: "priya@example.com", percent: 30 }],
      });
      assert.equal(out.status, "awaiting_user_confirmation", "splits must need confirmation");
      return "Please confirm.";
    }
    if (msg.startsWith("Refund")) {
      const r = db.data.requests[0];
      const out = await execute("refund_payment", { request_id: r.id, amount: 50, reason: "discount" });
      assert.equal(out.status, "awaiting_user_confirmation");
      return "Confirm the refund.";
    }
    return "ok";
  });
  const srv = await serve(app);
  try {
    // 1. Chat creates a pending action (because of the split)
    let res = await fetch(srv.base + "/api/chat", { method: "POST", body: JSON.stringify({ message: "Bill Ravi $450, Priya 30%" }) }).then((r) => r.json());
    assert.equal(res.state.pendingActions.length, 1);
    assert.equal(res.state.requests.length, 0);

    // 2. Human confirms → PayPal order created
    const actionId = res.state.pendingActions[0].id;
    res = await fetch(`${srv.base}/api/actions/${actionId}/confirm`, { method: "POST" }).then((r) => r.json());
    assert.equal(res.ok, true);
    const r = res.state.requests[0];
    assert.equal(r.status, "awaiting_payment");
    assert.equal(r.totalCents, 45000);
    assert.ok(r.payLink.includes("/mock-checkout/"));

    // 3. Client page renders with a Pay button
    const page = await fetch(`${srv.base}/pay/${r.id}`).then((x) => x.text());
    assert.match(page, /Pay \$450\.00 with PayPal/);

    // 4. Client approves at PayPal → return URL captures → paid → auto-split payout sent
    const orderId = r.paypalOrderId;
    const ret = await fetch(`${srv.base}/mock-checkout/${orderId}`, { redirect: "manual" });
    assert.equal(ret.status, 302);
    const ret2 = await fetch(srv.base + ret.headers.get("location"), { redirect: "manual" });
    assert.equal(ret2.status, 302);
    assert.match(ret2.headers.get("location"), /thanks=1/);

    const s = await fetch(srv.base + "/api/state").then((x) => x.json());
    const paid = s.requests[0];
    assert.equal(paid.status, "paid");
    assert.equal(paid.splits[0].status, "sent");
    assert.equal(paid.splits[0].cents, 13500);
    assert.equal(s.insights.collected.USD, 45000);
    assert.ok(s.events.some((e) => e.type === "payout"));

    // 5. Return URL again (double redirect / webhook race) must not double-process
    await fetch(srv.base + ret.headers.get("location"), { redirect: "manual" });
    assert.equal(db.data.events.filter((e) => e.type === "paid").length, 1);

    // 6. Partial refund through the agent + confirmation
    res = await fetch(srv.base + "/api/chat", { method: "POST", body: JSON.stringify({ message: "Refund $50" }) }).then((x) => x.json());
    const refundAction = res.state.pendingActions[0].id;
    res = await fetch(`${srv.base}/api/actions/${refundAction}/confirm`, { method: "POST" }).then((x) => x.json());
    assert.equal(res.state.requests[0].status, "partially_refunded");
    assert.equal(res.state.requests[0].refunds[0].cents, 5000);
  } finally {
    srv.close();
  }
});

test("reminders escalate and produce WhatsApp links; insights see overdue", async () => {
  const { app, db } = setup(async (execute, msg) => {
    if (msg === "bill") {
      await execute("create_payment_request", { client_name: "Acme", client_phone: "+91 98765 43210", items: [{ name: "Audit", unit_price: 200 }], due_date: "2020-01-01" });
      return "created";
    }
    const r = db.data.requests[0];
    const out = await execute("save_reminder", { request_id: r.id, message: `Hi Acme, ${r.id} is overdue`, tone: "firm" });
    assert.equal(out.ok, true);
    return "saved";
  });
  await app.chat("bill");
  const reply = await app.chat("remind");
  const card = reply.cards.find((c) => c.type === "reminder");
  assert.ok(card.whatsapp.startsWith("https://wa.me/919876543210?text="));
  const st = app.state();
  assert.equal(st.insights.counts.overdue, 1);
  assert.equal(st.requests[0].reminders.length, 1);
});

test("tool errors are returned to the model, not thrown", async () => {
  const { app } = setup(async (execute) => {
    const out = await execute("refund_payment", { request_id: "DU-NOPE" });
    assert.match(out.error, /No payment request/);
    const out2 = await execute("create_payment_request", { client_name: "X", items: [{ name: "Y", unit_price: 10 }], currency: "XYZ" });
    assert.match(out2.error, /isn't supported/);
    return "handled";
  });
  const reply = await app.chat("go");
  assert.equal(reply.text, "handled");
});

test("webhook CHECKOUT.ORDER.APPROVED captures and marks paid", async () => {
  const { app, paypal } = setup(async (execute) => {
    await execute("create_payment_request", { client_name: "Webhook Co", items: [{ name: "Thing", unit_price: 10 }] });
    return "ok";
  });
  await app.chat("go");
  const r = app.state().requests[0];
  paypal.approve(r.paypalOrderId);
  await app.handleWebhook({}, { event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: r.paypalOrderId } });
  assert.equal(app.state().requests[0].status, "paid");
});

test("gemini adapter: skips retired model, remembers working one, short-circuits confirmations", async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const model = url.match(/models\/([^:]+):/)[1];
    calls.push(model);
    if (model === "dead-model") return new Response(JSON.stringify({ error: { message: "gone" } }), { status: 404 });
    return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "refund_payment", args: { request_id: "X" } } }] } }] }), { status: 200 });
  };
  try {
    const agent = createAgent({ GEMINI_API_KEY: "k", AI_MODEL: "dead-model", AI_FALLBACK_MODELS: "good-model" });
    const run = () => agent.run({ system: "s", history: [], userMessage: "refund", tools: [], execute: async () => ({ status: "awaiting_user_confirmation" }) });
    const text = await run();
    assert.match(text, /Approve/);
    assert.deepEqual(calls, ["dead-model", "good-model"]); // one call on the good model, no follow-up
    calls.length = 0;
    await run();
    assert.deepEqual(calls, ["good-model"]); // dead model skipped next time
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("MCP server: external agent bills a client; its refund request waits for the owner's Confirm", async () => {
  const { spawn } = await import("node:child_process");
  const { app } = setup(async () => "unused");
  const srv = await serve(app);
  const child = spawn(process.execPath, ["mcp/duely-mcp.mjs"], { env: { ...process.env, DUELY_URL: srv.base }, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      pending.get(msg.id)?.(msg);
    }
  });
  let n = 0;
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const id = ++n;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  try {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "claude-ai", version: "1" }, capabilities: {} });
    assert.equal(init.result.serverInfo.name, "duely");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const list = await rpc("tools/list", {});
    assert.ok(list.result.tools.some((t) => t.name === "create_payment_request" && t.inputSchema.properties.items));

    const created = await rpc("tools/call", { name: "create_payment_request", arguments: { client_name: "Bot Client", items: [{ name: "Logo", unit_price: 99 }] } });
    assert.equal(created.result.isError, false);
    assert.equal(created.result.structuredContent.ok, true);

    // Simulate client payment, then the external agent asks for a refund → must be queued, not executed
    const st = app.state();
    const reqId = st.requests[0].id;
    await fetch(`${srv.base}/mock-checkout/${st.requests[0].paypalOrderId}`, { redirect: "follow" });
    assert.equal(app.state().requests[0].status, "paid");
    const refund = await rpc("tools/call", { name: "refund_payment", arguments: { request_id: reqId } });
    assert.equal(refund.result.structuredContent.status, "awaiting_user_confirmation");
    const after = app.state();
    assert.equal(after.requests[0].status, "paid", "refund must not run without the owner");
    assert.equal(after.pendingActions[0].requestedBy, "Claude Desktop");
    assert.ok(after.chat.some((m) => m.source === "Claude Desktop" && m.text.includes("Asked to refund payment")));
    assert.ok(after.events.some((e) => e.type === "agent"));

    const bad = await rpc("tools/call", { name: "refund_payment", arguments: { request_id: "NOPE" } });
    assert.equal(bad.result.isError, true);
  } finally {
    child.kill();
    srv.close();
  }
});

// ---------- PayPal Agent Toolkit integration ----------
import { parseToolkitResult } from "../lib/toolkit.js";
import { geminiSchema } from "../lib/agent.js";
import { agentToolDefs } from "../lib/tools.js";

function fakeToolkit() {
  const calls = [];
  let subStatus = "APPROVAL_PENDING";
  return {
    calls,
    version: "test",
    setStatus: (s) => (subStatus = s),
    has: (n) => ["list_disputes", "cancel_subscription", "accept_dispute_claim", "create_product", "create_subscription_plan", "create_subscription", "show_subscription_details"].includes(n),
    agentTools: () => [
      { name: "list_disputes", description: "List disputes", parameters: { type: "object", properties: { dispute_state: { anyOf: [{ type: "string" }, { type: "null" }] } } } },
      { name: "cancel_subscription", description: "Cancel", parameters: { type: "object", properties: { subscription_id: { type: "string" } }, required: ["subscription_id"] } },
    ],
    async call(name, input) {
      calls.push({ name, input });
      if (name === "create_product") return { id: "PROD-1" };
      if (name === "create_subscription_plan") return { id: "P-1", status: "ACTIVE" };
      if (name === "create_subscription") return { id: "I-SUB1", status: "APPROVAL_PENDING", links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=X" }] };
      if (name === "show_subscription_details") return { id: "I-SUB1", status: subStatus, billing_info: { next_billing_time: "2026-12-11T10:00:00Z" } };
      if (name === "list_disputes") return { items: [{ dispute_id: "PP-D-1", status: "OPEN" }] };
      if (name === "cancel_subscription") return { ok: true };
      throw new Error("unexpected " + name);
    },
  };
}

function setupWithToolkit(script) {
  const config = { publicUrl: "http://localhost:0", businessName: "Test Studio", defaultCurrency: "USD" };
  const db = createDb(null);
  const paypal = createPayPal({ mode: "mock", publicUrl: config.publicUrl });
  const toolkit = fakeToolkit();
  const agent = createAgent({}, { provider: "scripted", model: "test", run: async ({ execute, userMessage, tools }) => script(execute, userMessage, tools) });
  return { app: createApp({ db, paypal, agent, config, toolkit }), toolkit, db };
}

test("retainer: agent sets up a PayPal subscription via the official toolkit, client approves, owner cancels with approval", async () => {
  let seenTools;
  const { app, toolkit } = setupWithToolkit(async (execute, msg, tools) => {
    seenTools = tools.map((t) => t.name);
    if (msg.startsWith("retainer")) {
      const out = await execute("create_retainer", { client_name: "Acme", amount: 500, interval: "MONTH", description: "Website care" });
      assert.equal(out.ok, true);
      assert.ok(out.retainer.approve_link.includes("sandbox.paypal.com"));
      return "set up";
    }
    if (msg.startsWith("cancel")) {
      const out = await execute("cancel_retainer", { retainer_id: app.state().retainers[0].id, reason: "Project ended" });
      assert.equal(out.status, "awaiting_user_confirmation");
      return "approve please";
    }
    return "ok";
  });
  await app.chat("retainer for acme");
  assert.ok(seenTools.includes("create_retainer") && seenTools.includes("list_disputes"), "official tools are offered to the agent");
  assert.deepEqual(toolkit.calls.map((c) => c.name), ["create_product", "create_subscription_plan", "create_subscription"]);
  const plan = toolkit.calls[1].input;
  assert.equal(plan.billing_cycles[0].pricing_scheme.fixed_price.value, "500.00");
  assert.equal(plan.billing_cycles[0].frequency.interval_unit, "MONTH");
  assert.match(toolkit.calls[2].input.application_context.return_url, /\/retainer\/return$/);

  // Client approves at PayPal → poller picks it up
  toolkit.setStatus("ACTIVE");
  await app.poll();
  let st = app.state();
  assert.equal(st.retainers[0].status, "ACTIVE");
  assert.equal(st.insights.recurring.monthlyCents, 50000);
  assert.ok(st.events.some((e) => e.text.includes("approved their retainer")));

  // Cancelling needs approval, then calls the official cancel_subscription tool
  await app.chat("cancel acme");
  st = app.state();
  assert.equal(st.retainers[0].status, "ACTIVE", "nothing cancelled before approval");
  const { result } = await app.tools.confirm(st.pendingActions[0].id);
  assert.equal(result.ok, true);
  assert.equal(app.state().retainers[0].status, "CANCELLED");
  assert.equal(toolkit.calls.at(-1).name, "cancel_subscription");
});

test("official toolkit tools: reads run directly, guarded ones wait for approval", async () => {
  const { app, toolkit } = setupWithToolkit(async (execute) => {
    const d = await execute("list_disputes", {});
    assert.equal(d.items[0].dispute_id, "PP-D-1");
    const c = await execute("cancel_subscription", { subscription_id: "I-SUB1" });
    assert.equal(c.status, "awaiting_user_confirmation");
    return "done";
  });
  const reply = await app.chat("go");
  assert.ok(reply.cards.some((c) => c.type === "toolkit" && c.tool === "list_disputes"));
  assert.equal(toolkit.calls.filter((c) => c.name === "cancel_subscription").length, 0);
  assert.equal(app.state().pendingActions[0].tool, "cancel_subscription");
});

test("toolkit result parsing and schema conversion for Gemini", () => {
  assert.deepEqual(parseToolkitResult({ content: [{ text: '{"id":"X"}' }] }), { id: "X" });
  assert.throws(() => parseToolkitResult({ content: [{ text: '{"error":{"name":"NOT_AUTHORIZED","message":"Authorization failed"}}' }] }), /NOT_AUTHORIZED/);
  assert.throws(() => parseToolkitResult({ content: [{ text: "Error: something broke" }] }), /something broke/);
  const g = geminiSchema({ type: "object", properties: { a: { anyOf: [{ anyOf: [{ not: {} }, { type: "string" }] }, { type: "null" }] }, b: { $ref: "#/x" }, c: { type: ["number", "null"], minimum: 1 } }, additionalProperties: false, $schema: "x" });
  assert.deepEqual(g.properties.a, { type: "string" });
  assert.equal(g.properties.c.type, "number");
  assert.ok(!("additionalProperties" in g) && !("$schema" in g));
  assert.equal(agentToolDefs(null).some((t) => t.name === "list_disputes"), false);
});

test("toolkit parsing: double-encoded JSON and PayPal's ok:false errors", () => {
  const inner = JSON.stringify({ id: "PROD-1", name: "x" });
  assert.deepEqual(parseToolkitResult({ content: [{ text: JSON.stringify(inner) }] }), { id: "PROD-1", name: "x" });
  assert.throws(
    () => parseToolkitResult({ content: [{ text: JSON.stringify({ ok: false, status: 403, code: "PAYPAL_API_HTTP_ERROR", message: "Authorization failed due to insufficient permissions." }) }] }),
    /PAYPAL_API_HTTP_ERROR: Authorization failed/
  );
  assert.throws(() => parseToolkitResult({ content: [{ text: JSON.stringify({ error: { message: "not supported in sandbox mode", type: "paypal_error" } }) }] }), /sandbox/);
});

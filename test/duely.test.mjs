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
    assert.match(text, /Confirm/);
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

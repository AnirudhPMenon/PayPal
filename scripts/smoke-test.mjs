// Live check against the real PayPal sandbox + your AI provider.
// Run: npm run smoke
import { createPayPal } from "../lib/paypal.js";
import { createAgent } from "../lib/agent.js";
import { createOfficialToolkit } from "../lib/toolkit.js";

const env = process.env;
const ok = (m) => console.log("  ✓ " + m);
const bad = (m) => console.log("  ✗ " + m);
let failed = 0;

console.log("\nDuely smoke test\n");

// 1. PayPal auth + scopes
const paypal = createPayPal({ mode: "sandbox", clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET, publicUrl: "http://localhost:3000" });
try {
  const scopes = await paypal.scopes();
  ok("PayPal sandbox OAuth works");
  const need = { Orders: "checkout/payment-resources", Payouts: "payments/payouts", Refunds: "payments/refund" };
  for (const [name, frag] of Object.entries(need)) {
    if (scopes.some((s) => s.includes(frag))) ok(`${name} permission present`);
    else { bad(`${name} permission missing: enable it in your app's Features on developer.paypal.com`); failed++; }
  }
} catch (e) {
  bad(e.message); failed++;
}

// 2. Create a $1 test order
try {
  const order = await paypal.createOrder(
    { id: "SMOKE-" + Date.now().toString(36).toUpperCase(), client: { name: "Smoke Test" }, currency: "USD", items: [{ name: "Smoke test", description: "", quantity: 1, unitCents: 100 }] },
    { returnUrl: "http://localhost:3000/paypal/return", cancelUrl: "http://localhost:3000/", brandName: env.BUSINESS_NAME || "Duely" }
  );
  ok(`Order created: ${order.id} (${order.status})`);
} catch (e) {
  bad("Create order: " + e.message); failed++;
}

// 3. Payouts: send $1 to the sandbox personal account
if (env.RECIPIENT_EMAIL) {
  try {
    const p = await paypal.createPayout({
      batchId: "SMOKE-" + Date.now(),
      subject: "Duely smoke test",
      message: "Test payout",
      items: [{ email: env.RECIPIENT_EMAIL, cents: 100, currency: "USD", note: "Duely smoke test", itemId: "smoke-1" }],
    });
    ok(`Payout created: batch ${p.batch_header.payout_batch_id} (${p.batch_header.batch_status}) to ${env.RECIPIENT_EMAIL}`);
  } catch (e) {
    bad("Payouts: " + e.message); failed++;
  }
} else console.log("  – Skipping payout test (set RECIPIENT_EMAIL to a sandbox personal account email)");

// 4. PayPal Agent Toolkit (official tools)
const toolkit = createOfficialToolkit({ mode: "sandbox", clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET, log: () => {} });
if (!toolkit) {
  bad("PayPal Agent Toolkit not available: run npm install"); failed++;
} else {
  try {
    await toolkit.call("list_disputes", {});
    ok(`PayPal Agent Toolkit v${toolkit.version} works (list_disputes), ${toolkit.agentTools().length} official tools offered to the agent`);
  } catch (e) {
    bad("Agent Toolkit: " + e.message); failed++;
  }
}

// 5. AI provider with tool calling
const agent = createAgent(env);
if (agent.provider === "none") {
  bad("No AI key: add GEMINI_API_KEY (or ANTHROPIC_API_KEY / OPENAI_API_KEY) to .env"); failed++;
} else {
  try {
    let called = null;
    await agent.run({
      system: "You are a test. Call the add tool with a=2 and b=3, then say the result.",
      history: [],
      userMessage: "What is 2 + 3? Use the tool.",
      tools: [{ name: "add", description: "Add two numbers", parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } }],
      execute: async (name, args) => { called = { name, args }; return { sum: Number(args.a) + Number(args.b) }; },
      maxSteps: 3,
    });
    if (called) ok(`AI tool calling works (${agent.provider} · ${agent.model})`);
    else { bad(`${agent.provider} replied but didn't call the tool`); failed++; }
  } catch (e) {
    bad(e.message); failed++;
  }
}

console.log(failed ? `\n${failed} check(s) failed.\n` : "\nAll good, run: npm start\n");
process.exit(failed ? 1 : 0);

// Checks which PayPal Agent Toolkit tools work with your sandbox app.
// Run: node --env-file=.env scripts/probe-toolkit.mjs
import { createRequire } from "node:module";
import { parseToolkitResult } from "../lib/toolkit.js";
const require = createRequire(import.meta.url);
const { PayPalAgentToolkit, ALL_TOOLS_ENABLED } = require("@paypal/agent-toolkit/bedrock");

const tk = new PayPalAgentToolkit({
  clientId: process.env.PAYPAL_CLIENT_ID,
  clientSecret: process.env.PAYPAL_CLIENT_SECRET,
  configuration: { actions: ALL_TOOLS_ENABLED, context: { sandbox: true } },
});

let n = 0;
async function call(name, input) {
  const res = await tk.handleToolCall({ toolUseId: `probe-${++n}`, name, input });
  try {
    const data = parseToolkitResult(res);
    console.log(`\n✓ ${name}\n  ${JSON.stringify(data).slice(0, 400)}`);
    return data;
  } catch (e) {
    console.log(`\n✗ ${name}\n  ${e.message}`);
    return null;
  }
}

const day = 86400000;
const product = await call("create_product", { name: "Duely probe retainer", type: "SERVICE", description: "Probe" });
const plan = product?.id
  ? await call("create_subscription_plan", {
      product_id: product.id,
      name: "Probe monthly",
      billing_cycles: [{ frequency: { interval_unit: "MONTH", interval_count: 1 }, tenure_type: "REGULAR", sequence: 1, total_cycles: 0, pricing_scheme: { fixed_price: { currency_code: "USD", value: "1.00" } } }],
      payment_preferences: { auto_bill_outstanding: true },
    })
  : null;
if (plan?.id) {
  const sub = await call("create_subscription", {
    plan_id: plan.id,
    application_context: { brand_name: "Duely", return_url: "http://localhost:3000/retainer/return", cancel_url: "http://localhost:3000/", user_action: "SUBSCRIBE_NOW" },
  });
  const link = sub?.links?.find((l) => l.rel === "approve")?.href;
  if (link) console.log(`\n  → Client approval link: ${link}`);
  if (sub?.id) await call("show_subscription_details", { subscription_id: sub.id });
}
await call("list_disputes", {});
await call("list_transactions", { start_date: new Date(Date.now() - 20 * day).toISOString(), end_date: new Date().toISOString() });
await call("get_merchant_insights", { start_date: new Date(Date.now() - 30 * day).toISOString().slice(0, 10), end_date: new Date().toISOString().slice(0, 10), insight_type: "SALES", time_interval: "DAILY" });
console.log("\nDone.");

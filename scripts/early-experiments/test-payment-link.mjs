// Fallback for when Invoicing isn't available: an "invoice" built on the Orders API.
// Creates a PayPal order (= payment request), prints a pay link, waits for you to pay it
// as the sandbox personal account, then captures the money.
// Run:  node --env-file=.env test-payment-link.mjs

import readline from "node:readline/promises";

const BASE = "https://api-m.sandbox.paypal.com";
const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } = process.env;

async function call(path, options = {}) {
  const res = await fetch(BASE + path, options);
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    console.error(`\n${options.method || "GET"} ${path} -> ${res.status}`);
    console.error(JSON.stringify(body, null, 2));
    process.exit(1);
  }
  return body;
}

async function getAccessToken() {
  const basic = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");
  const data = await call("/v1/oauth2/token", {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  return data.access_token;
}

// This is the object the LLM will generate later from plain English.
const paymentRequest = {
  invoiceNumber: "INV-0001",
  client: "Ravi",
  currency: "USD",
  items: [{ name: "Landing page design", description: "3 responsive landing pages", quantity: 1, unitPrice: 150 }],
};

async function createOrder(token, req) {
  const total = req.items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0).toFixed(2);
  return call("/v2/checkout/orders", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: req.invoiceNumber,
          invoice_id: req.invoiceNumber, // must be unique per order in sandbox too
          description: `Invoice ${req.invoiceNumber} for ${req.client}`,
          amount: {
            currency_code: req.currency,
            value: total,
            breakdown: { item_total: { currency_code: req.currency, value: total } },
          },
          items: req.items.map((i) => ({
            name: i.name,
            description: i.description,
            quantity: String(i.quantity),
            unit_amount: { currency_code: req.currency, value: i.unitPrice.toFixed(2) },
            category: "DIGITAL_GOODS",
          })),
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: "Invoice Agent",
            user_action: "PAY_NOW",
            return_url: "https://example.com/paid",
            cancel_url: "https://example.com/cancelled",
          },
        },
      },
    }),
  });
}

const token = await getAccessToken();
console.log("✓ Got access token");

// Make the invoice number unique each run so PayPal doesn't reject duplicates
paymentRequest.invoiceNumber = `INV-${Date.now()}`;

const order = await createOrder(token, paymentRequest);
const payLink = order.links.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
console.log(`✓ Created order ${order.id} (status: ${order.status})`);
console.log(`\n  Pay link: ${payLink}\n`);
console.log("  Open it, log in as the sandbox PERSONAL account, and pay.");
console.log("  (You'll land on example.com afterwards — that's fine.)");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await rl.question("\nPress Enter once you've paid... ");
rl.close();

const captured = await call(`/v2/checkout/orders/${order.id}/capture`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
});
const capture = captured.purchase_units[0].payments.captures[0];
console.log(`✓ Captured: ${capture.amount.value} ${capture.amount.currency_code} (status: ${capture.status})`);

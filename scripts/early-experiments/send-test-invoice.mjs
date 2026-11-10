// Step 1 test: get a PayPal sandbox token, create a draft invoice, send it.
// Needs Node 20+ (built-in fetch and --env-file). No npm installs needed.
// Run:  node --env-file=.env send-test-invoice.mjs

const BASE = "https://api-m.sandbox.paypal.com";
const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, RECIPIENT_EMAIL } = process.env;

if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET || !RECIPIENT_EMAIL) {
  console.error("Missing PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET or RECIPIENT_EMAIL in .env");
  process.exit(1);
}

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

// 1. OAuth: swap client id + secret for an access token
async function getAccessToken() {
  const basic = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");
  const data = await call("/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  console.log(data.scope.split(" "));
  return data.access_token;
}

// 2. Create a draft invoice
async function createDraftInvoice(token) {
  const invoice = {
    detail: {
      currency_code: "USD",
      note: "Thanks for your business!",
      payment_term: { term_type: "NET_15" },
    },
    invoicer: {
      name: { given_name: "Anirudh", surname: "Menon" },
    },
    primary_recipients: [
      { billing_info: { email_address: RECIPIENT_EMAIL } },
    ],
    items: [
      {
        name: "Landing page design",
        description: "3 responsive landing pages",
        quantity: "1",
        unit_amount: { currency_code: "USD", value: "150.00" },
        unit_of_measure: "QUANTITY",
      },
    ],
  };

  return call("/v2/invoicing/invoices", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "return=representation", // return the full invoice, including its id
    },
    body: JSON.stringify(invoice),
  });
}

// 3. Send it (status goes DRAFT -> SENT, recipient gets the email in sandbox)
async function sendInvoice(token, id) {
  return call(`/v2/invoicing/invoices/${id}/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ send_to_invoicer: true }),
  });
}

async function getInvoice(token, id) {
  return call(`/v2/invoicing/invoices/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

const token = await getAccessToken();
console.log("✓ Got access token");

const draft = await createDraftInvoice(token);
console.log(`✓ Created draft invoice ${draft.id} (status: ${draft.status})`);

await sendInvoice(token, draft.id);
const sent = await getInvoice(token, draft.id);
console.log(`✓ Sent. Status now: ${sent.status}`);
console.log(`  Payer link: ${sent.detail?.metadata?.recipient_view_url ?? "(see sandbox account)"}`);

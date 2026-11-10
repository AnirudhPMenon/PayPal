// PayPal REST client: OAuth, Orders v2, Payments v2 (refunds), Payouts v1, Webhook verification.
// Plain fetch, no SDK. A "mock" mode exists only for automated tests and offline demos.

export class PayPalError extends Error {
  constructor(status, body, path) {
    const issue = body?.details?.[0]?.issue || body?.name || "UNKNOWN";
    const desc = body?.details?.[0]?.description || body?.message || "";
    super(`PayPal ${path} failed (${status} ${issue}): ${desc}`);
    this.status = status;
    this.body = body;
    this.issue = issue;
  }
}

const money = (cents) => (cents / 100).toFixed(2);
const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s);

// Build the Orders v2 request body for a Duely payment request.
export function buildOrderBody(req, { returnUrl, cancelUrl, brandName }) {
  const cur = req.currency;
  const itemTotal = req.items.reduce((s, i) => s + i.unitCents * i.quantity, 0);
  return {
    intent: "CAPTURE",
    purchase_units: [
      {
        reference_id: req.id,
        invoice_id: req.id,
        custom_id: req.id,
        description: clip(`Invoice ${req.id} for ${req.client.name}`, 127),
        amount: {
          currency_code: cur,
          value: money(itemTotal),
          breakdown: { item_total: { currency_code: cur, value: money(itemTotal) } },
        },
        items: req.items.map((i) => ({
          name: clip(i.name, 127),
          ...(i.description ? { description: clip(i.description, 127) } : {}),
          quantity: String(i.quantity),
          unit_amount: { currency_code: cur, value: money(i.unitCents) },
          category: "DIGITAL_GOODS",
        })),
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: clip(brandName || "Duely", 127),
          user_action: "PAY_NOW",
          shipping_preference: "NO_SHIPPING",
          return_url: returnUrl,
          cancel_url: cancelUrl,
        },
      },
    },
  };
}

export function extractCapture(order) {
  const cap = order?.purchase_units?.[0]?.payments?.captures?.[0];
  if (!cap) return null;
  return {
    captureId: cap.id,
    status: cap.status,
    amount: cap.amount,
    payerEmail: order.payer?.email_address || null,
    payerName: [order.payer?.name?.given_name, order.payer?.name?.surname].filter(Boolean).join(" ") || null,
  };
}

export function payLinkOf(order) {
  return order?.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href || null;
}

export function createPayPal({ mode = "sandbox", clientId, clientSecret, publicUrl } = {}) {
  if (mode === "mock") return createMockPayPal({ publicUrl });

  const BASE = mode === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
  let cached = null;

  async function token() {
    if (cached && cached.exp > Date.now() + 60_000) return cached.value;
    if (!clientId || !clientSecret) throw new Error("PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set");
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const res = await fetch(BASE + "/v1/oauth2/token", {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new PayPalError(res.status, data, "/v1/oauth2/token");
    cached = { value: data.access_token, exp: Date.now() + data.expires_in * 1000, scope: data.scope };
    return cached.value;
  }

  async function api(path, { method = "GET", body, requestId } = {}) {
    const t = await token();
    const headers = { Authorization: `Bearer ${t}`, "Content-Type": "application/json" };
    if (requestId) headers["PayPal-Request-Id"] = requestId; // idempotency
    const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!res.ok) throw new PayPalError(res.status, data, path);
    return data;
  }

  return {
    mode,
    async scopes() {
      await token();
      return cached.scope?.split(" ") || [];
    },
    createOrder: (req, opts) =>
      api("/v2/checkout/orders", { method: "POST", body: buildOrderBody(req, opts), requestId: `order-${req.id}` }),
    getOrder: (id) => api(`/v2/checkout/orders/${id}`),
    captureOrder: (id) => api(`/v2/checkout/orders/${id}/capture`, { method: "POST", requestId: `capture-${id}` }),
    refundCapture: (captureId, { cents, currency, note, requestId } = {}) =>
      api(`/v2/payments/captures/${captureId}/refund`, {
        method: "POST",
        requestId,
        body: {
          ...(cents ? { amount: { value: money(cents), currency_code: currency } } : {}),
          ...(note ? { note_to_payer: clip(note, 255) } : {}),
        },
      }),
    createPayout: ({ batchId, subject, message, items }) =>
      api("/v1/payments/payouts", {
        method: "POST",
        body: {
          sender_batch_header: { sender_batch_id: batchId, email_subject: subject, email_message: message },
          items: items.map((i) => ({
            recipient_type: "EMAIL",
            receiver: i.email,
            amount: { value: money(i.cents), currency: i.currency },
            note: clip(i.note || "Payment via Duely", 4000),
            sender_item_id: i.itemId,
          })),
        },
      }),
    getPayoutBatch: (batchId) => api(`/v1/payments/payouts/${batchId}`),
    verifyWebhook: async (headers, event, webhookId) => {
      const data = await api("/v1/notifications/verify-webhook-signature", {
        method: "POST",
        body: {
          auth_algo: headers["paypal-auth-algo"],
          cert_url: headers["paypal-cert-url"],
          transmission_id: headers["paypal-transmission-id"],
          transmission_sig: headers["paypal-transmission-sig"],
          transmission_time: headers["paypal-transmission-time"],
          webhook_id: webhookId,
          webhook_event: event,
        },
      });
      return data.verification_status === "SUCCESS";
    },
  };
}

// ---------- Mock (tests / offline demo only) ----------
function createMockPayPal({ publicUrl }) {
  const orders = new Map();
  const batches = new Map();
  let n = 0;
  return {
    mode: "mock",
    async scopes() {
      return ["mock"];
    },
    async createOrder(req, opts) {
      const body = buildOrderBody(req, opts);
      const id = `MOCK${Date.now().toString(36).toUpperCase()}${++n}`;
      const order = {
        id,
        status: "PAYER_ACTION_REQUIRED",
        body,
        links: [{ rel: "payer-action", href: `${publicUrl}/mock-checkout/${id}` }],
      };
      orders.set(id, order);
      return { id, status: order.status, links: order.links };
    },
    async getOrder(id) {
      const o = orders.get(id);
      if (!o) throw new PayPalError(404, { name: "RESOURCE_NOT_FOUND" }, `/v2/checkout/orders/${id}`);
      return o;
    },
    approve(id) {
      const o = orders.get(id);
      if (o && o.status !== "COMPLETED") o.status = "APPROVED";
      return o;
    },
    async captureOrder(id) {
      const o = orders.get(id);
      if (!o) throw new PayPalError(404, { name: "RESOURCE_NOT_FOUND" }, "capture");
      if (o.status === "COMPLETED")
        throw new PayPalError(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_ALREADY_CAPTURED" }] }, "capture");
      if (o.status !== "APPROVED")
        throw new PayPalError(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_NOT_APPROVED" }] }, "capture");
      o.status = "COMPLETED";
      o.payer = { email_address: "buyer@example.com", name: { given_name: "Sandbox", surname: "Buyer" } };
      o.purchase_units = [
        { payments: { captures: [{ id: `CAP-${id}`, status: "COMPLETED", amount: o.body.purchase_units[0].amount }] } },
      ];
      return o;
    },
    async refundCapture(captureId, { cents, currency } = {}) {
      return { id: `REF-${captureId}-${++n}`, status: "COMPLETED", amount: cents ? { value: money(cents), currency_code: currency } : null };
    },
    async createPayout({ batchId, items }) {
      const id = `PB-${++n}`;
      batches.set(id, { batchId, items });
      return { batch_header: { payout_batch_id: id, batch_status: "PENDING" } };
    },
    async getPayoutBatch(id) {
      return { batch_header: { payout_batch_id: id, batch_status: "SUCCESS" } };
    },
    async verifyWebhook() {
      return true;
    },
  };
}

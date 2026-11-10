// Business logic: payment requests, captures, auto-splits (Payouts), refunds, insights.
import { extractCapture, payLinkOf } from "./paypal.js";

const SUPPORTED = ["USD", "EUR", "GBP", "AUD", "CAD", "SGD", "CHF", "SEK", "NOK", "DKK", "PLN", "NZD", "HKD", "MXN", "BRL", "ILS", "CZK", "HUF", "PHP", "THB", "TWD"];

export const toCents = (n) => Math.round(Number(n) * 100);
export const fmt = (cents, cur = "USD") => {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${cur}`;
  }
};

export function newId() {
  // invoice_id must be unique per PayPal merchant forever, so derive it from time.
  return "DU-" + Date.now().toString(36).toUpperCase().slice(-6) + Math.random().toString(36).slice(2, 4).toUpperCase();
}

export function normalizeItems(items) {
  if (!Array.isArray(items) || items.length === 0) throw new Error("At least one line item is required");
  return items.map((raw) => {
    const name = String(raw.name || "").trim();
    if (!name) throw new Error("Every line item needs a name");
    let quantity = Number(raw.quantity ?? 1);
    let unitCents = toCents(raw.unit_price ?? raw.unitPrice);
    if (!Number.isFinite(quantity) || quantity <= 0) throw new Error(`Invalid quantity for "${name}"`);
    if (!Number.isFinite(unitCents) || unitCents <= 0) throw new Error(`Invalid price for "${name}"`);
    let finalName = name;
    // PayPal needs whole-number quantities: fold fractional ones (e.g. 2.5 hours) into one line.
    if (!Number.isInteger(quantity)) {
      unitCents = Math.round(unitCents * quantity);
      finalName = `${name} (${quantity} × ${(toCents(raw.unit_price ?? raw.unitPrice) / 100).toFixed(2)})`;
      quantity = 1;
    }
    return { name: finalName, description: raw.description ? String(raw.description) : "", quantity, unitCents };
  });
}

export function computeSplits(splits, totalCents, currency) {
  if (!splits?.length) return [];
  const out = splits.map((s) => {
    const percent = Number(s.percent);
    if (!s.email || !/^\S+@\S+\.\S+$/.test(s.email)) throw new Error(`Split for ${s.name || "collaborator"} needs a valid PayPal email`);
    if (!(percent > 0 && percent < 100)) throw new Error(`Split percent for ${s.name || s.email} must be between 0 and 100`);
    return { name: s.name || s.email, email: s.email, percent, cents: Math.floor((totalCents * percent) / 100), currency, status: "scheduled" };
  });
  const sum = out.reduce((a, s) => a + s.percent, 0);
  if (sum >= 100) throw new Error("Splits must add up to less than 100% — you need to keep something!");
  return out;
}

export function createService({ db, paypal, config }) {
  const inflight = new Set();
  const publicUrl = () => config.publicUrl;

  function view(r) {
    const now = Date.now();
    const overdue = r.status === "awaiting_payment" && r.dueDate && new Date(r.dueDate + "T23:59:59").getTime() < now;
    return { ...r, overdue, shareLink: `${publicUrl()}/pay/${r.id}` };
  }

  async function createRequest(input) {
    const currency = String(input.currency || config.defaultCurrency || "USD").toUpperCase();
    if (!SUPPORTED.includes(currency)) throw new Error(`Currency ${currency} isn't supported by PayPal checkout here. Try USD.`);
    const items = normalizeItems(input.items);
    const totalCents = items.reduce((s, i) => s + i.unitCents * i.quantity, 0);
    const req = {
      id: newId(),
      client: { name: String(input.client_name || "Client").trim(), email: input.client_email || null, phone: input.client_phone || null },
      items,
      currency,
      totalCents,
      dueDate: input.due_date || null,
      notes: input.notes || "",
      status: "creating",
      createdAt: new Date().toISOString(),
      splits: computeSplits(input.splits, totalCents, currency),
      reminders: [],
      refunds: [],
    };
    const order = await paypal.createOrder(req, {
      returnUrl: `${publicUrl()}/paypal/return`,
      cancelUrl: `${publicUrl()}/pay/${req.id}?cancelled=1`,
      brandName: config.businessName,
    });
    req.paypalOrderId = order.id;
    req.payLink = payLinkOf(order);
    req.status = "awaiting_payment";
    db.data.requests.unshift(req);
    db.save();
    db.log("created", `Payment request ${req.id} for ${req.client.name}: ${fmt(totalCents, currency)}`, { requestId: req.id });
    return view(req);
  }

  async function markPaid(req, cap) {
    if (req.status === "paid" || req.status === "refunded" || req.status === "partially_refunded") return;
    req.status = "paid";
    req.paidAt = new Date().toISOString();
    req.captureId = cap.captureId;
    req.payer = { email: cap.payerEmail, name: cap.payerName };
    db.save();
    db.log("paid", `${req.client.name} paid ${fmt(req.totalCents, req.currency)} for ${req.id}`, { requestId: req.id });
    await runSplits(req);
  }

  // Capture an approved order. Safe to call from return URL, webhook and poller at the same time.
  async function captureRequest(req) {
    if (req.status !== "awaiting_payment" || inflight.has(req.id)) return view(req);
    inflight.add(req.id);
    try {
      let order;
      try {
        order = await paypal.captureOrder(req.paypalOrderId);
      } catch (e) {
        if (e.issue === "ORDER_ALREADY_CAPTURED") order = await paypal.getOrder(req.paypalOrderId);
        else if (e.issue === "ORDER_NOT_APPROVED" || e.issue === "PAYER_ACTION_REQUIRED") return view(req);
        else throw e;
      }
      const cap = extractCapture(order);
      if (cap && cap.status === "COMPLETED") await markPaid(req, cap);
      else if (cap) {
        req.status = "pending_review";
        req.captureId = cap.captureId;
        db.save();
        db.log("info", `Payment for ${req.id} is ${cap.status} at PayPal`, { requestId: req.id });
      }
      return view(req);
    } finally {
      inflight.delete(req.id);
    }
  }

  async function syncRequest(req) {
    if (req.status === "awaiting_payment") {
      const order = await paypal.getOrder(req.paypalOrderId);
      if (order.status === "APPROVED") return captureRequest(req);
      if (order.status === "COMPLETED") {
        const cap = extractCapture(order);
        if (cap) await markPaid(req, cap);
      }
    }
    // Refresh payout statuses
    const batches = [...new Set(req.splits.filter((s) => s.batchId && s.status === "sent").map((s) => s.batchId))];
    for (const b of batches) {
      try {
        const res = await paypal.getPayoutBatch(b);
        const st = res.batch_header?.batch_status;
        if (st === "SUCCESS") req.splits.filter((s) => s.batchId === b).forEach((s) => (s.status = "completed"));
        if (st === "DENIED" || st === "CANCELED") req.splits.filter((s) => s.batchId === b).forEach((s) => (s.status = "failed"));
      } catch {
        /* keep previous status */
      }
    }
    db.save();
    return view(req);
  }

  async function runSplits(req) {
    const due = req.splits.filter((s) => s.status === "scheduled" || s.status === "failed");
    if (!due.length) return;
    try {
      const res = await paypal.createPayout({
        batchId: `${req.id}-split-${Date.now()}`,
        subject: `You've received your share for ${req.id}`,
        message: `${config.businessName} sent your share for "${req.items[0].name}" via Duely.`,
        items: due.map((s, i) => ({
          email: s.email,
          cents: s.cents,
          currency: s.currency,
          note: `${s.percent}% share of ${req.id} (${req.client.name})`,
          itemId: `${req.id}-${i}`,
        })),
      });
      const batchId = res.batch_header?.payout_batch_id;
      for (const s of due) {
        s.status = "sent";
        s.batchId = batchId;
        s.sentAt = new Date().toISOString();
        delete s.error;
        db.log("payout", `Auto-split: sent ${fmt(s.cents, s.currency)} (${s.percent}%) to ${s.name} via PayPal Payouts`, { requestId: req.id });
      }
    } catch (e) {
      for (const s of due) {
        s.status = "failed";
        s.error = e.message;
      }
      db.log("error", `Auto-split for ${req.id} failed: ${e.message}`, { requestId: req.id });
    }
    db.save();
  }

  async function refundRequest(req, { amount, reason } = {}) {
    if (!["paid", "partially_refunded"].includes(req.status) || !req.captureId) throw new Error(`${req.id} has no completed payment to refund`);
    const already = req.refunds.reduce((s, r) => s + r.cents, 0);
    const remaining = req.totalCents - already;
    const cents = amount ? toCents(amount) : remaining;
    if (!(cents > 0) || cents > remaining) throw new Error(`Refund must be between 0 and ${fmt(remaining, req.currency)}`);
    const res = await paypal.refundCapture(req.captureId, {
      cents: cents === req.totalCents && already === 0 ? undefined : cents,
      currency: req.currency,
      note: reason,
      requestId: `refund-${req.id}-${already}-${cents}`,
    });
    req.refunds.push({ id: res.id, cents, reason: reason || "", at: new Date().toISOString(), status: res.status });
    req.status = already + cents >= req.totalCents ? "refunded" : "partially_refunded";
    db.save();
    db.log("refund", `Refunded ${fmt(cents, req.currency)} to ${req.client.name} for ${req.id}`, { requestId: req.id });
    return view(req);
  }

  async function sendPayout({ name, email, amount, currency, note }) {
    const cur = String(currency || config.defaultCurrency || "USD").toUpperCase();
    const cents = toCents(amount);
    if (!(cents > 0)) throw new Error("Payout amount must be positive");
    if (!/^\S+@\S+\.\S+$/.test(email || "")) throw new Error("A valid PayPal email is required");
    const res = await paypal.createPayout({
      batchId: `DU-PAY-${Date.now()}`,
      subject: `${config.businessName} sent you a payment`,
      message: note || "Sent via Duely",
      items: [{ email, cents, currency: cur, note, itemId: `pay-${Date.now()}` }],
    });
    db.log("payout", `Sent ${fmt(cents, cur)} to ${name || email} via PayPal Payouts`);
    return { batchId: res.batch_header?.payout_batch_id, status: res.batch_header?.batch_status, cents, currency: cur, name, email };
  }

  function cancelRequest(req) {
    if (req.status !== "awaiting_payment") throw new Error(`${req.id} is ${req.status}; only unpaid requests can be cancelled`);
    req.status = "cancelled";
    db.save();
    db.log("info", `Cancelled ${req.id} for ${req.client.name}`, { requestId: req.id });
    return view(req);
  }

  function addReminder(req, { message, tone, channel }) {
    const r = { at: new Date().toISOString(), message, tone: tone || "friendly", channel: channel || "whatsapp" };
    req.reminders.push(r);
    db.save();
    db.log("reminder", `Reminder #${req.reminders.length} (${r.tone}) drafted for ${req.client.name} on ${req.id}`, { requestId: req.id });
    return r;
  }

  function insights() {
    const rs = db.data.requests.map(view);
    const byCur = (list) => {
      const m = {};
      for (const r of list) m[r.currency] = (m[r.currency] || 0) + r.totalCents - (r.refunds || []).reduce((a, x) => a + x.cents, 0);
      return m;
    };
    const awaiting = rs.filter((r) => r.status === "awaiting_payment");
    const paid = rs.filter((r) => ["paid", "partially_refunded"].includes(r.status));
    const month = new Date().toISOString().slice(0, 7);
    const paidThisMonth = paid.filter((r) => r.paidAt?.startsWith(month));
    const days = paid.filter((r) => r.paidAt).map((r) => (new Date(r.paidAt) - new Date(r.createdAt)) / 86400000);
    const debtors = {};
    for (const r of awaiting) debtors[r.client.name] = (debtors[r.client.name] || 0) + r.totalCents;
    const topDebtor = Object.entries(debtors).sort((a, b) => b[1] - a[1])[0];
    const splitsSent = rs.flatMap((r) => r.splits).filter((s) => ["sent", "completed"].includes(s.status));
    return {
      outstanding: byCur(awaiting),
      collected: byCur(paid),
      collectedThisMonth: byCur(paidThisMonth),
      counts: { total: rs.length, awaiting: awaiting.length, paid: paid.length, overdue: awaiting.filter((r) => r.overdue).length },
      avgDaysToPay: days.length ? +(days.reduce((a, b) => a + b, 0) / days.length).toFixed(1) : null,
      topDebtor: topDebtor ? { name: topDebtor[0], cents: topDebtor[1] } : null,
      splitsSentCents: byCur(splitsSent.map((s) => ({ currency: s.currency, totalCents: s.cents }))),
    };
  }

  return { view, createRequest, captureRequest, syncRequest, runSplits, refundRequest, sendPayout, cancelRequest, addReminder, insights };
}

// Tools the AI agent can call. Money-moving tools never run directly:
// they create a pending action that the human must confirm in the UI.
import { fmt } from "./service.js";

const itemSchema = {
  type: "object",
  properties: {
    name: { type: "string", description: "Short line item name, e.g. 'Landing page design'" },
    description: { type: "string", description: "Optional detail" },
    quantity: { type: "number", description: "Quantity or hours. Default 1" },
    unit_price: { type: "number", description: "Price per unit in the request currency, e.g. 150" },
  },
  required: ["name", "unit_price"],
};

export const toolDefs = [
  {
    name: "create_payment_request",
    description:
      "Create a PayPal payment request (an invoice backed by a PayPal order) and get a pay link for the client. Use when the user wants to bill/charge/invoice someone. If the user mentions sharing revenue with a collaborator (e.g. 'Priya gets 30%'), include splits — they are paid automatically via PayPal Payouts when the client pays, after the user confirms.",
    parameters: {
      type: "object",
      properties: {
        client_name: { type: "string" },
        client_email: { type: "string", description: "Client email if known" },
        client_phone: { type: "string", description: "Client phone with country code if known, for WhatsApp" },
        items: { type: "array", items: itemSchema },
        currency: { type: "string", description: "ISO code, default USD" },
        due_date: { type: "string", description: "YYYY-MM-DD. Convert relative dates like 'Friday' or 'in 10 days' using today's date." },
        notes: { type: "string" },
        splits: {
          type: "array",
          description: "Optional revenue shares for collaborators, paid automatically on payment",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              email: { type: "string", description: "Collaborator's PayPal email" },
              percent: { type: "number", description: "Percent of the total, e.g. 30" },
            },
            required: ["name", "email", "percent"],
          },
        },
      },
      required: ["client_name", "items"],
    },
  },
  {
    name: "list_payment_requests",
    description: "List payment requests, optionally filtered by status or client name.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["awaiting_payment", "paid", "overdue", "refunded", "cancelled", "all"] },
        client: { type: "string" },
      },
    },
  },
  {
    name: "check_payment_status",
    description: "Ask PayPal for the live status of a request and capture the payment if the client has approved it.",
    parameters: { type: "object", properties: { request_id: { type: "string" } }, required: ["request_id"] },
  },
  {
    name: "save_reminder",
    description:
      "Save a payment reminder you have written for an unpaid request and get WhatsApp/email share links. Write the message yourself first: personal, short, includes amount, request id and the pay link. Escalate tone with each previous reminder (friendly → firm → final).",
    parameters: {
      type: "object",
      properties: {
        request_id: { type: "string" },
        message: { type: "string", description: "The full reminder text, including the pay link" },
        tone: { type: "string", enum: ["friendly", "firm", "final"] },
        channel: { type: "string", enum: ["whatsapp", "email"] },
      },
      required: ["request_id", "message", "tone"],
    },
  },
  {
    name: "get_insights",
    description: "Cash-flow summary: outstanding, collected, overdue, top debtor, average days to pay, payouts sent.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "refund_payment",
    description: "Refund a paid request fully or partially via PayPal. Requires the user's confirmation in the UI.",
    parameters: {
      type: "object",
      properties: {
        request_id: { type: "string" },
        amount: { type: "number", description: "Partial amount; omit for a full refund" },
        reason: { type: "string" },
      },
      required: ["request_id"],
    },
  },
  {
    name: "send_payout",
    description: "Send money to someone's PayPal email (e.g. pay a subcontractor) via PayPal Payouts. Requires the user's confirmation in the UI.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        email: { type: "string" },
        amount: { type: "number" },
        currency: { type: "string" },
        note: { type: "string" },
      },
      required: ["email", "amount"],
    },
  },
  {
    name: "cancel_payment_request",
    description: "Cancel an unpaid request.",
    parameters: { type: "object", properties: { request_id: { type: "string" } }, required: ["request_id"] },
  },
  {
    name: "create_retainer",
    description:
      "Set up recurring billing (a retainer) for a client through PayPal Subscriptions, using PayPal's official Agent Toolkit. Use when the user wants to bill someone every week, month or year. Returns a subscription link the client approves once; PayPal then bills them automatically. USD only.",
    parameters: {
      type: "object",
      properties: {
        client_name: { type: "string" },
        client_email: { type: "string", description: "Client email if known" },
        amount: { type: "number", description: "Amount per billing period in USD, e.g. 500" },
        interval: { type: "string", enum: ["WEEK", "MONTH", "YEAR"], description: "How often to bill. Default MONTH" },
        description: { type: "string", description: "What the retainer covers, e.g. 'Website maintenance'" },
      },
      required: ["client_name", "amount"],
    },
  },
  {
    name: "cancel_retainer",
    description: "Cancel a client's retainer (PayPal subscription). Requires the user's approval in the UI.",
    parameters: {
      type: "object",
      properties: { retainer_id: { type: "string", description: "Retainer id like RT-XXXX, or the PayPal subscription id" }, reason: { type: "string" } },
      required: ["retainer_id"],
    },
  },
];

// Official PayPal Agent Toolkit tools are added at runtime (see lib/toolkit.js).
export function agentToolDefs(toolkit) {
  return toolkit ? [...toolDefs, ...toolkit.agentTools().map(({ name, description, parameters }) => ({ name, description: `[PayPal Agent Toolkit] ${description}`, parameters }))] : toolDefs;
}

export const compactRetainer = (r) => ({
  id: r.id,
  client: r.client.name,
  amount: `${fmt(r.amountCents, r.currency)} per ${r.interval.toLowerCase()}`,
  status: r.status,
  subscription_id: r.subscriptionId,
  approve_link: r.status === "APPROVAL_PENDING" ? r.approveLink : undefined,
  next_billing: r.nextBillingAt?.slice(0, 10),
});

const compact = (r) => ({
  id: r.id,
  client: r.client.name,
  total: fmt(r.totalCents, r.currency),
  status: r.overdue ? "overdue" : r.status,
  due: r.dueDate,
  created: r.createdAt.slice(0, 10),
  paid_at: r.paidAt?.slice(0, 10),
  reminders_sent: r.reminders.length,
  pay_link: r.shareLink,
  splits: r.splits.map((s) => `${s.name} ${s.percent}% (${s.status})`),
});

export function waLink(phone, text) {
  const digits = (phone || "").replace(/[^\d]/g, "");
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}
export function mailLink(email, subject, text) {
  return `mailto:${email || ""}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
}

export function createToolRunner({ db, service, toolkit = null }) {
  const GUARDED_OFFICIAL = new Set(["cancel_subscription", "accept_dispute_claim"]);
  function mustFindRetainer(id) {
    const r = db.findRetainer(id);
    if (!r) throw new Error(`No retainer with id ${id}`);
    return r;
  }
  function mustFind(id) {
    const r = db.findRequest(id);
    if (!r) throw new Error(`No payment request with id ${id}`);
    return r;
  }

  function pending(tool, args, summary, cards, opts = {}) {
    const action = { id: "act_" + Math.random().toString(36).slice(2, 10), tool, args, summary, createdAt: new Date().toISOString(), ...(opts.source ? { requestedBy: opts.source } : {}) };
    db.data.pendingActions.push(action);
    db.save();
    cards.push({ type: "confirm", action });
    const note = opts.source
      ? "Queued for human approval: the Duely owner must press Approve in their dashboard. Nothing has moved yet. Use check_payment_status or list_payment_requests later to see the outcome."
      : "Tell the user to review and press Approve. Do not claim it is done.";
    return { status: "awaiting_user_confirmation", action_id: action.id, summary, note };
  }

  // Execute an action for real (after confirmation, or directly for safe tools).
  async function perform(tool, args, cards) {
    switch (tool) {
      case "create_payment_request": {
        const r = await service.createRequest(args);
        cards.push({ type: "request", request: r });
        return { ok: true, request: compact(r), share_link: r.shareLink, note: "Give the user the share link and a short ready-to-send message for the client." };
      }
      case "refund_payment": {
        const r = await service.refundRequest(mustFind(args.request_id), args);
        cards.push({ type: "request", request: r });
        return { ok: true, request: compact(r) };
      }
      case "send_payout": {
        const p = await service.sendPayout(args);
        cards.push({ type: "payout", payout: p });
        return { ok: true, payout: { ...p, amount: fmt(p.cents, p.currency) } };
      }
      case "cancel_retainer": {
        const r = await service.cancelRetainer(mustFindRetainer(args.retainer_id), args.reason);
        cards.push({ type: "retainer", retainer: r });
        return { ok: true, retainer: compactRetainer(r) };
      }
      default:
        if (toolkit && GUARDED_OFFICIAL.has(tool)) {
          const data = await toolkit.call(tool, args);
          cards.push({ type: "toolkit", tool, done: true });
          db.log("info", `Ran ${tool.replace(/_/g, " ")} with the PayPal Agent Toolkit`);
          return { ok: true, result: data };
        }
        throw new Error(`Unknown tool ${tool}`);
    }
  }

  async function execute(name, args = {}, cards = [], opts = {}) {
    try {
      switch (name) {
        case "create_payment_request": {
          if (args.splits?.length) {
            const total = (args.items || []).reduce((s, i) => s + Number(i.unit_price || 0) * Number(i.quantity || 1), 0);
            const cur = (args.currency || "USD").toUpperCase();
            const summary = `Bill ${args.client_name} ${fmt(Math.round(total * 100), cur)} and auto-pay ${args.splits
              .map((s) => `${s.name} ${s.percent}% (${fmt(Math.floor(total * s.percent), cur)}) to ${s.email}`)
              .join(", ")} via PayPal Payouts when the client pays.`;
            return pending(name, args, summary, cards, opts);
          }
          return await perform(name, args, cards);
        }
        case "refund_payment": {
          const r = mustFind(args.request_id);
          const amt = args.amount ? fmt(Math.round(args.amount * 100), r.currency) : `the full ${fmt(r.totalCents - r.refunds.reduce((s, x) => s + x.cents, 0), r.currency)}`;
          return pending(name, args, `Refund ${amt} to ${r.client.name} for ${r.id}${args.reason ? ` (${args.reason})` : ""}.`, cards, opts);
        }
        case "send_payout": {
          const cur = (args.currency || "USD").toUpperCase();
          return pending(name, args, `Send ${fmt(Math.round(args.amount * 100), cur)} to ${args.name || args.email} (${args.email}) via PayPal Payouts.`, cards, opts);
        }
        case "list_payment_requests": {
          let rs = db.data.requests.map(service.view);
          if (args.status === "overdue") rs = rs.filter((r) => r.overdue);
          else if (args.status && args.status !== "all") rs = rs.filter((r) => r.status === args.status);
          if (args.client) rs = rs.filter((r) => r.client.name.toLowerCase().includes(args.client.toLowerCase()));
          return { count: rs.length, requests: rs.slice(0, 25).map(compact) };
        }
        case "check_payment_status": {
          const r = await service.syncRequest(mustFind(args.request_id));
          cards.push({ type: "request", request: r });
          return { request: compact(r) };
        }
        case "save_reminder": {
          const r = mustFind(args.request_id);
          if (r.status !== "awaiting_payment") return { error: `${r.id} is ${r.status}, no reminder needed` };
          const rem = service.addReminder(r, args);
          const card = {
            type: "reminder",
            requestId: r.id,
            client: r.client.name,
            tone: rem.tone,
            number: r.reminders.length,
            message: args.message,
            whatsapp: waLink(r.client.phone, args.message),
            email: mailLink(r.client.email, `Reminder: ${r.id} (${fmt(r.totalCents, r.currency)})`, args.message),
          };
          cards.push(card);
          return { ok: true, reminder_number: r.reminders.length, note: "The user can send it with one tap from the card." };
        }
        case "get_insights": {
          const i = service.insights();
          cards.push({ type: "insights", insights: i });
          return i;
        }
        case "cancel_payment_request": {
          const r = service.cancelRequest(mustFind(args.request_id));
          cards.push({ type: "request", request: r });
          return { ok: true, request: compact(r) };
        }
        case "create_retainer": {
          const r = await service.createRetainer(args);
          cards.push({ type: "retainer", retainer: r });
          return { ok: true, retainer: compactRetainer(r), note: "Give the user the approve_link and a short message for the client. The client approves once in PayPal, then billing is automatic." };
        }
        case "cancel_retainer": {
          const r = mustFindRetainer(args.retainer_id);
          return pending(name, args, `Cancel ${r.client.name}'s retainer ${r.id} (${fmt(r.amountCents)} per ${r.interval.toLowerCase()})${args.reason ? `: ${args.reason}` : ""}.`, cards, opts);
        }
        default: {
          if (toolkit?.has(name)) {
            if (GUARDED_OFFICIAL.has(name)) {
              const what = name === "accept_dispute_claim" ? `Accept the buyer's claim on dispute ${args.dispute_id || ""}` : `Cancel PayPal subscription ${args.subscription_id || ""}`;
              return pending(name, args, `${what} using the PayPal Agent Toolkit. This can't be undone.`, cards, opts);
            }
            const data = await toolkit.call(name, args);
            cards.push({ type: "toolkit", tool: name });
            const text = JSON.stringify(data);
            // Keep big listings (e.g. transactions) from flooding the model's context.
            return text.length > 8000 ? { truncated: true, note: "Result was long; summarize what is shown.", preview: text.slice(0, 8000) } : data;
          }
          return { error: `Unknown tool ${name}` };
        }
      }
    } catch (e) {
      return { error: e.message };
    }
  }

  async function confirm(actionId) {
    const list = db.data.pendingActions;
    const idx = list.findIndex((a) => a.id === actionId);
    if (idx === -1) throw new Error("This action was already handled or has expired");
    const [action] = list.splice(idx, 1);
    db.save();
    const cards = [];
    const result = await perform(action.tool, action.args, cards);
    return { action, result, cards };
  }

  function dismiss(actionId) {
    const list = db.data.pendingActions;
    const idx = list.findIndex((a) => a.id === actionId);
    if (idx === -1) return null;
    const [action] = list.splice(idx, 1);
    db.save();
    return action;
  }

  return { execute, confirm, dismiss, compact, compactRetainer };
}

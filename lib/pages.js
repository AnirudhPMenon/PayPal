// Server-rendered client-facing pages (invoice + messages).
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const shell = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><link rel="icon" href="/favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--paper:#f6f7f5;--ink:#18201d;--muted:#66706b;--rule:#dce1dd;--soft:#e9ece9;--green:#1e5a47;--amber:#a8620b;--brick:#a33a2c}
*{box-sizing:border-box}body{margin:0;font-family:"Public Sans",system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--paper);color:var(--ink);font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased;line-height:1.5}
.wrap{max-width:520px;margin:56px auto;padding:0 18px}.sheet{background:#fff;border:1px solid var(--rule);border-radius:10px;padding:32px}
.top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:28px}.biz{font-weight:700;font-size:18px;letter-spacing:-.01em}.muted{color:var(--muted);font-size:13.5px}
.status{display:inline-flex;align-items:center;gap:6px;font-weight:500;font-size:13.5px;white-space:nowrap}.status::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}
.paid{color:var(--green)}.due{color:var(--amber)}.overdue{color:var(--brick)}
table{width:100%;border-collapse:collapse}td{padding:12px 0;border-bottom:1px solid var(--soft);font-size:14.5px;vertical-align:top}td:last-child{text-align:right;white-space:nowrap}
.total{display:flex;justify-content:space-between;align-items:baseline;font-size:22px;font-weight:700;letter-spacing:-.01em;margin:18px 0 26px}
.pay{display:block;text-align:center;background:#ffc439;color:#111;font-weight:700;padding:14px;border-radius:8px;text-decoration:none;font-size:15.5px}.pay:hover{background:#f2b52e}
.pay:focus-visible{outline:2px solid var(--green);outline-offset:3px}
.banner{padding:14px 16px;border-radius:8px;margin-bottom:16px;font-weight:600;border:1px solid}.banner.ok{background:#e7efeb;border-color:#c4d8cf;color:var(--green)}.banner.wait{background:#fbf1e3;border-color:#ecd3ad;color:var(--amber)}
.foot{text-align:center;margin-top:18px}
</style></head><body><div class="wrap">${body}<p class="foot muted">Payments are processed securely by PayPal.</p></div></body></html>`;

export const pages = {
  message: (title, text) => shell(title, `<div class="sheet"><h2 style="margin:0 0 6px;font-size:20px">${esc(title)}</h2><p class="muted" style="margin:0">${esc(text)}</p></div>`),

  invoice(r, config, { thanks, cancelled, fmt }) {
    const paid = ["paid", "partially_refunded"].includes(r.status);
    const rows = r.items
      .map((i) => `<tr><td><b>${esc(i.name)}</b>${i.description ? `<div class="muted">${esc(i.description)}</div>` : ""}${i.quantity > 1 ? `<div class="muted">${i.quantity} × ${fmt(i.unitCents, r.currency)}</div>` : ""}</td><td>${fmt(i.unitCents * i.quantity, r.currency)}</td></tr>`)
      .join("");
    let banner = "";
    if (thanks && paid) banner = `<div class="banner ok">Payment received. Thank you, ${esc(r.payer?.name || r.client.name)}.</div>`;
    else if (thanks) banner = `<div class="banner wait">PayPal is confirming your payment. Refresh this page in a moment.</div>`;
    else if (cancelled) banner = `<div class="banner wait">You cancelled the payment. You can pay below whenever you're ready.</div>`;
    let action = "";
    if (r.status === "awaiting_payment" && r.payLink) action = `<a class="pay" href="${esc(r.payLink)}">Pay ${fmt(r.totalCents, r.currency)} with PayPal</a>`;
    else if (r.status === "cancelled") action = `<p class="muted">This request was cancelled.</p>`;
    else if (r.status === "refunded") action = `<p class="muted">This payment was refunded.</p>`;
    const due = r.dueDate ? new Date(r.dueDate + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
    const status = paid
      ? `<span class="status paid">Paid</span>`
      : r.status === "awaiting_payment"
        ? `<span class="status ${r.overdue ? "overdue" : "due"}">${r.overdue ? "Overdue" : "Due"}${due ? " " + esc(due) : ""}</span>`
        : `<span class="status due">${esc({ refunded: "Refunded", cancelled: "Cancelled", pending_review: "In review" }[r.status] || r.status)}</span>`;
    return shell(
      `${r.id} · ${config.businessName}`,
      `${banner}<div class="sheet">
        <div class="top"><div><div class="biz">${esc(config.businessName)}</div><div class="muted">Invoice ${esc(r.id)} for ${esc(r.client.name)}</div></div>${status}</div>
        <table>${rows}</table>
        <div class="total"><span>Total</span><span>${fmt(r.totalCents, r.currency)}</span></div>
        ${r.notes ? `<p class="muted">${esc(r.notes)}</p>` : ""}
        ${action}
      </div>`
    );
  },
};

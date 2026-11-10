// Duely dashboard + assistant. Vanilla JS, AG Grid Community for the table.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (cents, cur = "USD") => {
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format((cents || 0) / 100); }
  catch { return `${((cents || 0) / 100).toFixed(2)} ${cur}`; }
};
const fmtMap = (m) => { const e = Object.entries(m || {}).filter(([, v]) => v); return e.length ? e.map(([c, v]) => fmt(v, c)).join(" + ") : fmt(0); };
const total = (m) => Object.values(m || {}).reduce((a, b) => a + b, 0);
const ago = (iso) => {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return "Just now"; if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
};
const niceDate = (d) => (d ? new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "No due date");
const md = (t) => esc(t)
  .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
  .replace(/(https?:\/\/[^\s<)]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');

const STATUS = { awaiting_payment: "Awaiting", overdue: "Overdue", paid: "Paid", refunded: "Refunded", partially_refunded: "Partly refunded", cancelled: "Cancelled", pending_review: "In review" };
const statusOf = (r) => (r.overdue ? "overdue" : r.status);
const APPROVAL_TITLE = { create_payment_request: "Approve bill with revenue split", refund_payment: "Approve refund", send_payout: "Approve payout" };
const SPLIT_STATE = { scheduled: "when the client pays", sent: "sent via PayPal Payouts", completed: "paid out", failed: "failed, will retry" };

let state = null;
let gridApi = null;
let busy = false;
let lastChatKey = "";
const knownStatus = new Map();

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return res.json();
}
async function refresh() { try { apply(await api("/api/state")); } catch { /* retry next tick */ } }

function apply(s) {
  for (const r of s.requests) {
    const prev = knownStatus.get(r.id);
    if (prev && prev !== "paid" && r.status === "paid") toast(`${r.client.name} paid ${fmt(r.totalCents, r.currency)}`, "money");
    knownStatus.set(r.id, r.status);
  }
  state = s;
  renderTop(); renderSummary(); renderGrid(); renderFeed(); renderLog();
}

// ---------- Top bar ----------
function renderTop() {
  const c = state.config;
  const env = $("#env");
  env.textContent = c.paypalMode === "sandbox" ? "PayPal sandbox connected" : c.paypalMode === "live" ? "PayPal live" : "Offline test mode";
  env.classList.toggle("off", c.paypalMode !== "sandbox" && c.paypalMode !== "live");
  $("#business").textContent = c.businessName;
  $("#aiInfo").textContent = c.provider === "none" ? "Add an AI key to .env to start" : "Bills, chases and pays through PayPal";
}

// ---------- Summary sentence ----------
function renderSummary() {
  const i = state.insights;
  const owedClients = new Set(state.requests.filter((r) => r.status === "awaiting_payment").map((r) => r.client.name)).size;
  let h;
  if (!state.requests.length) h = `Nothing billed yet. <span class="quiet">Tell the assistant who to bill.</span>`;
  else if (total(i.outstanding) > 0) h = `You're owed ${fmtMap(i.outstanding)} by ${owedClients} ${owedClients === 1 ? "client" : "clients"}.`;
  else h = `Everyone has paid. <span class="quiet">${fmtMap(i.collected)} collected.</span>`;
  $("#headline").innerHTML = h;

  const days = i.avgDaysToPay == null ? "No data yet" : i.avgDaysToPay < 1 ? "Same day" : `${i.avgDaysToPay} days`;
  const fact = (dt, dd, cls = "") => `<div><dt>${dt}</dt><dd class="${cls}">${dd}</dd></div>`;
  $("#facts").innerHTML =
    fact("Collected", fmtMap(i.collected)) +
    fact("Overdue", i.counts.overdue ? `${i.counts.overdue} ${i.counts.overdue === 1 ? "request" : "requests"}` : "None", i.counts.overdue ? "warn" : "") +
    fact("Clients usually pay", days) +
    fact("Paid to collaborators", fmtMap(i.splitsSentCents));
}

// ---------- Table ----------
function actionsCell(p) {
  const r = p.data;
  const el = document.createElement("div");
  el.className = "row-actions";
  const add = (label, fn) => { const b = document.createElement("button"); b.type = "button"; b.textContent = label; b.onclick = (e) => { e.stopPropagation(); fn(); }; el.appendChild(b); };
  add("Copy link", () => { navigator.clipboard?.writeText(r.shareLink); toast("Pay link copied"); });
  if (r.status === "awaiting_payment") add("Remind", () => send(`Write reminder ${r.reminders.length + 1} for ${r.id} and save it`));
  if (r.status === "paid" || r.status === "partially_refunded") add("Refund", () => send(`Refund ${r.id}`));
  return el;
}

const columns = [
  { headerName: "Client", valueGetter: (p) => p.data.client.name, flex: 1.2, minWidth: 130, cellStyle: { fontWeight: 600 } },
  { field: "id", headerName: "Invoice", width: 130, cellStyle: { color: "#66706b" } },
  { headerName: "Amount", valueGetter: (p) => p.data.totalCents / 100, valueFormatter: (p) => fmt(p.data.totalCents, p.data.currency), width: 115, type: "rightAligned" },
  { headerName: "Status", valueGetter: (p) => statusOf(p.data), width: 140, cellRenderer: (p) => `<span class="status ${p.value}">${STATUS[p.value] || p.value}</span>` },
  { field: "dueDate", headerName: "Due", width: 105, valueFormatter: (p) => (p.value ? niceDate(p.value) : "None") },
  { headerName: "Revenue split", flex: 1, minWidth: 140, valueGetter: (p) => p.data.splits.map((s) => `${s.name} ${s.percent}%`).join(", ") || "None" },
  { headerName: "", width: 170, cellRenderer: actionsCell, sortable: false, filter: false, resizable: false },
];

function gridTheme() {
  const t = window.agGrid?.themeQuartz;
  if (!t?.withParams) return undefined;
  return t.withParams({
    fontFamily: "Public Sans, system-ui, sans-serif", fontSize: 13.5, foregroundColor: "#18201d", textColor: "#18201d",
    headerTextColor: "#66706b", headerFontWeight: 500, headerBackgroundColor: "#ffffff", backgroundColor: "#ffffff",
    borderColor: "#dce1dd", rowBorder: { color: "#e9ece9" }, wrapperBorderRadius: 8, accentColor: "#1e5a47",
    rowHoverColor: "#f6f7f5", selectedRowBackgroundColor: "#e7efeb", headerColumnResizeHandleColor: "transparent", spacing: 7,
  });
}

function renderGrid() {
  const rows = state.requests;
  if (window.agGrid?.createGrid) {
    if (!gridApi) {
      gridApi = agGrid.createGrid($("#grid"), {
        theme: gridTheme(), columnDefs: columns, rowData: rows, getRowId: (p) => p.data.id,
        defaultColDef: { sortable: true, resizable: true }, rowHeight: 46, headerHeight: 40, domLayout: "autoHeight",
        overlayNoRowsTemplate: '<span style="color:#66706b">No payment requests yet. Ask the assistant to bill someone.</span>',
      });
      $("#quickFilter").addEventListener("input", (e) => gridApi.setGridOption("quickFilterText", e.target.value));
    } else gridApi.setGridOption("rowData", rows);
    return;
  }
  $("#grid").style.height = "auto";
  $("#grid").innerHTML = rows.length
    ? `<table class="fallback"><thead><tr><th>Client</th><th>Invoice</th><th>Amount</th><th>Status</th><th>Due</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.client.name)}</td><td>${r.id}</td><td>${fmt(r.totalCents, r.currency)}</td><td><span class="status ${statusOf(r)}">${STATUS[statusOf(r)]}</span></td><td>${niceDate(r.dueDate)}</td></tr>`).join("")}</tbody></table>`
    : `<div class="empty-state">No payment requests yet. Ask the assistant to bill someone.</div>`;
}

// ---------- Activity ----------
function renderFeed() {
  const ev = state.events.filter((e) => e.type !== "webhook").slice(0, 30);
  $("#feed").innerHTML = ev.length
    ? ev.map((e) => `<li><span class="dot ${e.type}"></span><span>${esc(e.text.replace(/^🤖\s*/, ""))}</span><time datetime="${e.at}">${ago(e.at)}</time></li>`).join("")
    : `<li class="empty">Bills, payments, payouts and reminders will be listed here as they happen.</li>`;
}

// ---------- Assistant log ----------
function renderLog(force) {
  const key = state.chat.length + "|" + state.pendingActions.map((a) => a.id).join(",") + "|" + state.requests.map((r) => r.status).join(",") + "|" + busy;
  if (!force && key === lastChatKey) return;
  lastChatKey = key;
  const box = $("#messages");
  if (!state.chat.length) {
    box.innerHTML = `<div class="intro">
      <p>Tell me who to bill and I'll take care of the PayPal side.</p>
      <ul>
        <li>I create a pay link and write the message for your client.</li>
        <li>When they pay, collaborators get their share through PayPal Payouts.</li>
        <li>If they don't, I write reminders that get firmer each time.</li>
        <li>Other AI agents can bill and pay through me too. You approve every payout.</li>
      </ul></div>`;
  } else {
    box.innerHTML = state.chat.map(turnHtml).join("");
  }
  if (busy) box.insertAdjacentHTML("beforeend", `<div class="working">Working on it…</div>`);
  box.scrollTop = box.scrollHeight;
  renderSuggestions();
}

function turnHtml(m) {
  const who = m.role === "user" ? "You" : m.source ? `${esc(m.source)}, via MCP` : "Assistant";
  const cls = ["turn", m.role, m.error ? "error" : "", m.source ? "agent" : ""].join(" ");
  const text = m.error ? m.text.replace(/^⚠️\s*/, "") : m.text;
  return `<div class="${cls}"><div class="who">${who}</div><div class="text">${md(text)}</div></div>` + (m.cards || []).map(docHtml).join("");
}

const liveRequest = (id) => state.requests.find((r) => r.id === id);

function docHtml(c) {
  if (c.type === "request") {
    const r = liveRequest(c.request.id) || c.request;
    const st = statusOf(r);
    const msg = `Hi ${r.client.name}, here's invoice ${r.id} for ${fmt(r.totalCents, r.currency)}${r.dueDate ? `, due ${niceDate(r.dueDate)}` : ""}. You can pay securely with PayPal: ${r.shareLink}`;
    const lines = r.items.map((i) => `<div class="line"><span>${esc(i.name)}${i.quantity > 1 ? ` × ${i.quantity}` : ""}</span><span>${fmt(i.unitCents * i.quantity, r.currency)}</span></div>`).join("");
    const splits = r.splits.map((s) => `<div class="split-note">${esc(s.name)} receives ${s.percent}% (${fmt(s.cents, s.currency)}), ${SPLIT_STATE[s.status] || s.status}</div>`).join("");
    const open = r.status === "awaiting_payment";
    return `<div class="doc">
      <div class="doc-head"><span class="doc-title">Invoice ${esc(r.id)} for ${esc(r.client.name)}</span><span class="status ${st}">${STATUS[st] || st}</span></div>
      ${lines}<div class="line total"><span>Total</span><span>${fmt(r.totalCents, r.currency)}</span></div>${splits}
      <div class="actions">
        <a class="btn primary" href="${esc(r.shareLink)}" target="_blank" rel="noopener">Open pay page</a>
        <button class="btn" type="button" data-copy="${esc(r.shareLink)}">Copy link</button>
        ${open ? `<a class="btn" target="_blank" rel="noopener" href="https://wa.me/${(r.client.phone || "").replace(/\D/g, "")}?text=${encodeURIComponent(msg)}">WhatsApp</a>
        <a class="btn" href="mailto:${esc(r.client.email || "")}?subject=${encodeURIComponent(`Invoice ${r.id}`)}&body=${encodeURIComponent(msg)}">Email</a>` : ""}
      </div></div>`;
  }
  if (c.type === "confirm") {
    const live = state.pendingActions.some((a) => a.id === c.action.id);
    return `<div class="doc approval">
      <div class="doc-head"><span class="doc-title">${APPROVAL_TITLE[c.action.tool] || "Approve action"}</span></div>
      ${c.action.requestedBy ? `<div class="requested">Requested by ${esc(c.action.requestedBy)} over MCP</div>` : ""}
      <div>${esc(c.action.summary)}</div>
      ${live
        ? `<div class="actions"><button class="btn primary" type="button" data-approve="${c.action.id}">Approve</button><button class="btn" type="button" data-decline="${c.action.id}">Decline</button></div>`
        : `<div class="handled">Handled</div>`}
    </div>`;
  }
  if (c.type === "reminder") {
    const tone = { friendly: "Friendly", firm: "Firm", final: "Final notice" }[c.tone] || c.tone;
    return `<div class="doc">
      <div class="doc-head"><span class="doc-title">Reminder ${c.number} to ${esc(c.client)}</span><span class="doc-meta">${esc(tone)}</span></div>
      <div class="quote">${md(c.message)}</div>
      <div class="actions"><a class="btn primary" target="_blank" rel="noopener" href="${esc(c.whatsapp)}">Send on WhatsApp</a>
      <a class="btn" href="${esc(c.email)}">Send email</a>
      <button class="btn" type="button" data-copy="${esc(c.message)}">Copy</button></div></div>`;
  }
  if (c.type === "payout") {
    const p = c.payout;
    return `<div class="doc">
      <div class="doc-head"><span class="doc-title">Payout to ${esc(p.name || p.email)}</span><span class="status paid">Sent</span></div>
      <div class="line"><span>${esc(p.email)}</span><span>${fmt(p.cents, p.currency)}</span></div>
      <div class="doc-meta">PayPal batch ${esc(p.batchId)}</div></div>`;
  }
  if (c.type === "insights") {
    const i = c.insights;
    return `<div class="doc">
      <div class="doc-head"><span class="doc-title">Cash flow</span></div>
      <div class="line"><span>Outstanding</span><span>${fmtMap(i.outstanding)}</span></div>
      <div class="line"><span>Collected this month</span><span>${fmtMap(i.collectedThisMonth)}</span></div>
      <div class="line"><span>Overdue requests</span><span>${i.counts.overdue}</span></div>
      ${i.topDebtor ? `<div class="line"><span>Owes you the most</span><span>${esc(i.topDebtor.name)}, ${fmt(i.topDebtor.cents)}</span></div>` : ""}
    </div>`;
  }
  return "";
}

// Delegated clicks for buttons inside the log
$("#messages").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.copy) { navigator.clipboard?.writeText(b.dataset.copy); toast("Copied"); }
  if (b.dataset.approve) {
    b.disabled = true;
    const res = await api(`/api/actions/${b.dataset.approve}/confirm`, {});
    apply(res.state);
    toast(res.ok ? "Approved" : res.error || "That didn't go through");
  }
  if (b.dataset.decline) { apply((await api(`/api/actions/${b.dataset.decline}/cancel`, {})).state); toast("Declined. Nothing was sent."); }
});

function renderSuggestions() {
  const box = $("#chips");
  const last = state.chat[state.chat.length - 1];
  const lastUser = [...state.chat].reverse().find((m) => m.role === "user");
  if (last?.error && lastUser && !busy) {
    box.innerHTML = `<button type="button" class="retry">Try again: ${esc(lastUser.text.slice(0, 70))}</button>`;
    box.firstChild.onclick = () => send(lastUser.text);
    return;
  }
  const unpaid = state.requests.find((r) => r.status === "awaiting_payment");
  const paid = state.requests.find((r) => r.status === "paid");
  const list = [];
  if (!state.requests.length) {
    list.push("Bill Ravi $450 for 3 landing pages, due Friday");
    list.push("Invoice Acme Corp for 12.5 hours of API work at $40/hr, due in 10 days");
  } else {
    if (unpaid) list.push(`Chase ${unpaid.client.name}`);
    list.push("Who owes me money?");
    if (paid) list.push(`Refund $20 to ${paid.client.name} as a goodwill discount`);
  }
  box.innerHTML = list.slice(0, 3).map((t) => `<button type="button">${esc(t)}</button>`).join("");
  box.querySelectorAll("button").forEach((b) => (b.onclick = () => { $("#input").value = b.textContent; $("#input").focus(); }));
}

async function send(text) {
  text = (text ?? $("#input").value).trim();
  if (!text || busy) return;
  busy = true;
  $("#input").value = "";
  $("#sendBtn").disabled = true;
  state.chat = [...state.chat, { role: "user", text }];
  renderLog(true);
  try {
    const res = await api("/api/chat", { message: text });
    busy = false;
    if (res.error) toast(res.error);
    if (res.state) apply(res.state);
  } catch (e) {
    toast("Couldn't reach the Duely server. Check that it's running.");
  } finally {
    busy = false;
    $("#sendBtn").disabled = false;
    renderLog(true);
  }
}

function toast(text, kind = "") {
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  t.textContent = text;
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

$("#composer").addEventListener("submit", (e) => { e.preventDefault(); send(); });
$("#input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
$("#resetBtn").onclick = async () => {
  if (!window.confirm("Clear all demo data? PayPal sandbox records are not affected.")) return;
  knownStatus.clear();
  apply((await api("/api/reset", {})).state);
};

refresh();
setInterval(() => { if (!busy) refresh(); }, 4000);

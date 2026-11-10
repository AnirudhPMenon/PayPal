// Provider-agnostic tool-calling agent loop: Anthropic (Claude), OpenAI, or Google Gemini.
// Uses each provider's native function-calling API via fetch, no SDKs.

export function pickProvider(env) {
  const p = (env.AI_PROVIDER || "").toLowerCase();
  if (p) return p;
  if (env.ANTHROPIC_API_KEY) return "anthropic";
  if (env.OPENAI_API_KEY) return "openai";
  if (env.GEMINI_API_KEY) return "gemini";
  return "none";
}

export const DEFAULT_MODELS = {
  anthropic: "claude-sonnet-5-5",
  openai: "gpt-4.1-mini",
  gemini: "gemini-flash-lite-latest",
};

// History must alternate user/assistant and start with a user turn.
export function normalizeHistory(history) {
  const out = [];
  for (const h of history) {
    if (!h.text) continue;
    const role = h.role === "assistant" ? "assistant" : "user";
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].text += "\n\n" + h.text;
    else out.push({ role, text: h.text });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

// POST with retries + exponential backoff for overloaded / rate-limited providers.
const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 25000);
const label = (url) => url.replace(/^https:\/\/[^/]+/, "").replace(/\?.*$/, "");

async function postJson(url, headers, body, { retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res, text;
    const t0 = Date.now();
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      text = await res.text();
      console.log(`  [ai] ${label(url)} → ${res.status} in ${Date.now() - t0}ms`);
    } catch (e) {
      const timedOut = e.name === "TimeoutError" || e.name === "AbortError";
      console.log(`  [ai] ${label(url)} → ${timedOut ? "timeout" : e.message} after ${Date.now() - t0}ms`);
      if (attempt < retries) {
        await sleep(800 * 2 ** attempt);
        continue;
      }
      const err = new Error(timedOut ? `AI provider timed out after ${TIMEOUT_MS / 1000}s` : `AI provider unreachable: ${e.message}`);
      err.status = 504;
      throw err;
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    if (res.ok) return data;
    if (RETRYABLE.has(res.status) && attempt < retries) {
      await sleep(800 * 2 ** attempt + Math.random() * 300);
      continue;
    }
    const msg = data?.error?.message || data?.error?.status || data?.raw || res.statusText;
    const err = new Error(`AI provider error (${res.status}): ${String(msg).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
}

// When every tool call in a step only produced a pending confirmation, there's nothing for the
// model to add: skip the extra round trip and answer instantly.
const CONFIRM_TEXT = "Review the details on the card and press **Confirm** when it looks right.";
const allAwaitingConfirmation = (outs) => outs.length > 0 && outs.every((o) => o?.status === "awaiting_user_confirmation");
const geminiState = { sticky: null, dead: new Set() };

// Each adapter: given system, history, user message, tool defs and an executor, run the loop and return final text.
const adapters = {
  async anthropic({ env, model, system, history, userMessage, tools, execute, maxSteps }) {
    const messages = [...history.map((h) => ({ role: h.role, content: h.text })), { role: "user", content: userMessage }];
    const toolSpec = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    let lastText = "";
    for (let step = 0; step < maxSteps; step++) {
      const res = await postJson(
        "https://api.anthropic.com/v1/messages",
        { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        { model, max_tokens: 1500, system, tools: toolSpec, messages }
      );
      const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      if (text) lastText = text;
      const uses = res.content.filter((b) => b.type === "tool_use");
      if (!uses.length) return lastText;
      messages.push({ role: "assistant", content: res.content });
      const results = [];
      const outs = [];
      for (const u of uses) {
        const out = await execute(u.name, u.input || {});
        outs.push(out);
        results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(out) });
      }
      if (allAwaitingConfirmation(outs)) return CONFIRM_TEXT;
      messages.push({ role: "user", content: results });
    }
    return lastText || "I hit my step limit. Can you rephrase or split that into smaller asks?";
  },

  async openai({ env, model, system, history, userMessage, tools, execute, maxSteps }) {
    const messages = [{ role: "system", content: system }, ...history.map((h) => ({ role: h.role, content: h.text })), { role: "user", content: userMessage }];
    const toolSpec = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
    let lastText = "";
    for (let step = 0; step < maxSteps; step++) {
      const res = await postJson(
        (env.OPENAI_BASE_URL || "https://api.openai.com/v1") + "/chat/completions",
        { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
        { model, messages, tools: toolSpec }
      );
      const msg = res.choices[0].message;
      if (msg.content) lastText = msg.content.trim();
      if (!msg.tool_calls?.length) return lastText;
      messages.push(msg);
      const outs = [];
      for (const c of msg.tool_calls) {
        let args = {};
        try {
          args = JSON.parse(c.function.arguments || "{}");
        } catch {
          /* leave empty */
        }
        const out = await execute(c.function.name, args);
        outs.push(out);
        messages.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(out) });
      }
      if (allAwaitingConfirmation(outs)) return CONFIRM_TEXT;
    }
    return lastText || "I hit my step limit. Can you rephrase or split that into smaller asks?";
  },

  async gemini({ env, model, system, history, userMessage, tools, execute, maxSteps }) {
    const contents = [
      ...history.map((h) => ({ role: h.role === "assistant" ? "model" : "user", parts: [{ text: h.text }] })),
      { role: "user", parts: [{ text: userMessage }] },
    ];
    const toolSpec = [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: geminiSchema(t.parameters) })) }];
    let lastText = "";
    // Fall back to other models if the primary is overloaded, slow or retired.
    const models = [geminiState.sticky, model, ...(env.AI_FALLBACK_MODELS || "gemini-flash-latest,gemini-3.8-flash").split(",").map((s) => s.trim())].filter((m, i, a) => m && !geminiState.dead.has(m) && a.indexOf(m) === i);
    if (!models.length) models.push(model);
    // Billing extraction doesn't need deep reasoning: keep thinking low so replies are fast.
    let thinking = env.GEMINI_THINKING === "off" ? null : { thinkingConfig: { thinkingLevel: env.GEMINI_THINKING || "low" } };
    let mi = 0;
    for (let step = 0; step < maxSteps; step++) {
      let res;
      for (;;) {
        try {
          res = await postJson(
            `https://generativelanguage.googleapis.com/v1beta/models/${models[mi]}:generateContent`,
            { "x-goog-api-key": env.GEMINI_API_KEY },
            { systemInstruction: { parts: [{ text: system }] }, contents, tools: toolSpec, ...(thinking ? { generationConfig: thinking } : {}) },
            { retries: 1 }
          );
          geminiState.sticky = models[mi]; // remember the model that works
          break;
        } catch (e) {
          if (e.status === 400 && thinking && /thinking/i.test(e.message)) {
            thinking = null; // this model doesn't accept a thinking level; retry without it
            continue;
          }
          if (e.status === 404) geminiState.dead.add(models[mi]); // retired model: never try again
          if (geminiState.sticky === models[mi]) geminiState.sticky = null;
          if ([404, 429, 500, 503, 504].includes(e.status) && mi < models.length - 1) {
            console.log(`  [ai] ${models[mi]} unavailable (${e.status}), switching to ${models[mi + 1]}`);
            mi++;
            continue;
          }
          throw e;
        }
      }
      const content = res.candidates?.[0]?.content || { role: "model", parts: [] };
      const parts = content.parts || [];
      const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("\n").trim();
      if (text) lastText = text;
      const calls = parts.filter((p) => p.functionCall);
      if (!calls.length) return lastText;
      contents.push({ role: "model", parts });
      const responses = [];
      for (const p of calls) {
        const result = await execute(p.functionCall.name, p.functionCall.args || {});
        responses.push({ functionResponse: { name: p.functionCall.name, response: { result } } });
      }
      if (allAwaitingConfirmation(responses.map((r) => r.functionResponse.response.result))) return CONFIRM_TEXT;
      contents.push({ role: "user", parts: responses });
    }
    return lastText || "I hit my step limit. Can you rephrase or split that into smaller asks?";
  },
};

// Gemini accepts an OpenAPI subset; strip anything it may reject.
function geminiSchema(s) {
  if (!s || typeof s !== "object") return s;
  const out = {};
  for (const k of ["type", "description", "enum", "required", "items", "properties"]) if (s[k] !== undefined) out[k] = s[k];
  if (out.properties) {
    if (!Object.keys(out.properties).length) return { type: "object", properties: { _: { type: "string", description: "unused" } } };
    out.properties = Object.fromEntries(Object.entries(out.properties).map(([k, v]) => [k, geminiSchema(v)]));
  }
  if (out.items) out.items = geminiSchema(out.items);
  return out;
}

export function createAgent(env, overrides = {}) {
  const provider = overrides.provider || pickProvider(env);
  const model = overrides.model || env.AI_MODEL || DEFAULT_MODELS[provider];
  return {
    provider,
    model,
    async run({ system, history, userMessage, tools, execute, maxSteps = 8 }) {
      if (overrides.run) return overrides.run({ system, history, userMessage, tools, execute, maxSteps });
      const adapter = adapters[provider];
      if (!adapter) throw new Error("No AI provider configured. Add ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY to .env and restart.");
      let toolsRan = 0;
      const tracked = async (name, args) => {
        toolsRan++;
        return execute(name, args);
      };
      for (let attempt = 0; ; attempt++) {
        try {
          return await adapter({ env, model, system, history: normalizeHistory(history), userMessage, tools, execute: tracked, maxSteps });
        } catch (e) {
          // Provider overloaded before anything happened? Safe to retry the whole turn once.
          if (attempt === 0 && toolsRan === 0 && [429, 500, 503, 504].includes(e.status)) {
            console.log("  [ai] all models busy, retrying the turn in 3s");
            await sleep(Number(env.AI_TURN_RETRY_MS ?? 3000));
            continue;
          }
          if ([429, 503].includes(e.status)) e.message = "The AI model is overloaded right now (provider-side). Tap Retry in a few seconds.";
          throw e;
        }
      }
    },
  };
}

export function buildSystemPrompt({ businessName, ownerName, defaultCurrency, requests, today }) {
  return `You are Duely, an AI finance agent that gets freelancers and small businesses paid through PayPal.
You work for ${ownerName ? `${ownerName} (${businessName})` : businessName}. Today is ${today}. Default currency: ${defaultCurrency}.

What you do:
- Turn plain-English billing requests into PayPal payment requests with create_payment_request. Extract client, line items, quantities, prices, due date (convert relative dates to YYYY-MM-DD), and revenue splits for collaborators.
- After create_payment_request returns ok, reply with: one line confirming the total and due date, then a short, warm, ready-to-send message to the client that includes the exact share_link from the tool result. Keep it under 60 words.
- If a tool returns status "awaiting_user_confirmation", reply in ONE short sentence asking the user to review and press Confirm on the card. Do not write a client message or any link yet; nothing exists until they confirm.
- Chase unpaid requests: write the reminder yourself (personal, specific, includes amount, request id and share link) and save it with save_reminder. Escalate tone based on reminders_sent: 0 → friendly, 1 → firm, 2+ → final. The card already shows the full message with send buttons, so after saving reply with ONE short line (e.g. which reminder number and tone). Don't repeat the message.
- Answer cash-flow questions with get_insights or list_payment_requests. "Collected" is already net of refunds.
- Refunds and payouts move money: call the tool, then tell the user to press Confirm on the card. Never say money moved until a tool result says ok.

Rules:
- Never invent pay links, ids or amounts, and never write placeholders like [Pay Link]. Use only what tools return.
- If a price is missing, ask for it. Don't guess. A missing email or due date is fine.
- If a tool returns an error, explain it plainly and suggest the fix.
- Be concise. Use **bold** for key numbers. No headings.

Current payment requests (most recent first):
${JSON.stringify(requests)}`;
}

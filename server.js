// Duely: AI agent that gets freelancers paid with PayPal.
// Start:  npm start   (or: node --env-file=.env server.js)
import http from "node:http";
import path from "node:path";
import { createDb } from "./lib/db.js";
import { createPayPal } from "./lib/paypal.js";
import { createAgent } from "./lib/agent.js";
import { createApp } from "./lib/app.js";
import { createOfficialToolkit } from "./lib/toolkit.js";

const env = process.env;
const PORT = Number(env.PORT || 3000);
const config = {
  publicUrl: (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, ""),
  businessName: env.BUSINESS_NAME || "Duely Studio",
  ownerName: env.OWNER_NAME || "",
  defaultCurrency: (env.DEFAULT_CURRENCY || "USD").toUpperCase(),
  webhookId: env.PAYPAL_WEBHOOK_ID || "",
  apiKey: env.DUELY_API_KEY || "",
};

const db = createDb(env.DB_FILE || path.join(process.cwd(), "data", "db.json"));
const paypal = createPayPal({ mode: env.PAYPAL_MODE || "sandbox", clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET, publicUrl: config.publicUrl });
const agent = createAgent(env);
const toolkit = createOfficialToolkit({ mode: env.PAYPAL_MODE || "sandbox", clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET });
const app = createApp({ db, paypal, agent, config, toolkit });

http.createServer(app.handler).listen(PORT, () => {
  console.log(`\n  Duely is running → ${config.publicUrl}`);
  console.log(`  PayPal: ${paypal.mode} · AI: ${agent.provider}${agent.model ? ` (${agent.model})` : ""}`);
  console.log(`  PayPal Agent Toolkit: ${toolkit ? `v${toolkit.version || "?"} (${toolkit.agentTools().length} official tools + retainers)` : "off"}`);
  if (agent.provider === "none") console.log("  ⚠ No AI key found. Add ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY to .env");
  if (paypal.mode !== "mock" && !env.PAYPAL_CLIENT_ID) console.log("  ⚠ PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET missing from .env");
  console.log("");
});

setInterval(() => app.poll().catch(() => {}), Number(env.POLL_MS || 15000));
